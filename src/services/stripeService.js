'use strict';

/**
 * stripeService.js
 * ----------------------------------------------------------------------------
 * Everything that talks to the Stripe SDK or understands Stripe data lives here:
 *   1. Creating the Stripe client (TEST MODE keys only)
 *   2. Verifying the Stripe-Signature header
 *   3. Extracting the payment fields we care about
 *   4. Masking e-mail addresses (privacy by default)
 *   5. Remembering event IDs so duplicates are skipped
 *
 * Settings are read from process.env at call time (not at import time). That
 * keeps the code easy to test and means nothing sensitive is hardcoded.
 */

const Stripe = require('stripe');

/* -------------------------------------------------------------------------- */
/* Custom error                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the SERVER is configured wrongly (for example, the webhook
 * secret is missing). This is our fault, not the caller's, so the route turns
 * it into HTTP 500 instead of 400.
 */
class WebhookConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookConfigError';
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Stripe client                                                           */
/* -------------------------------------------------------------------------- */

let cachedClient = null;
let cachedKey = null;

/**
 * Returns a Stripe client built from STRIPE_SECRET_KEY.
 * The client is cached so we do not rebuild it for every request.
 */
function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new WebhookConfigError('STRIPE_SECRET_KEY is not set.');
  }
  assertTestModeKey(key);
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Stripe(key);
    cachedKey = key;
  }
  return cachedClient;
}

/**
 * This project is TEST MODE ONLY. Refuse anything that is not a test key.
 * Stripe test keys start with sk_test_ (secret) or rk_test_ (restricted).
 */
function assertTestModeKey(key) {
  const isTestKey = /^(sk|rk)_test_/.test(String(key || ''));
  if (!isTestKey) {
    throw new WebhookConfigError(
      'STRIPE_SECRET_KEY must be a Stripe TEST key (starts with sk_test_ or rk_test_). Live keys are not allowed in this project.'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Signature verification                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verifies that a webhook really came from Stripe and was not changed.
 *
 * @param {Buffer} rawBody   The EXACT bytes Stripe sent (from express.raw).
 *                           If the body was parsed or re-serialised first,
 *                           verification will fail.
 * @param {string} signature The value of the Stripe-Signature header.
 * @returns {object} The verified Stripe event.
 * @throws {WebhookConfigError} if the webhook secret is not configured.
 * @throws {Error} Stripe's StripeSignatureVerificationError if the signature
 *                 is wrong, too old, or the payload was tampered with.
 */
function verifyWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookConfigError('STRIPE_WEBHOOK_SECRET is not set.');
  }
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * True when an error means "the caller sent us something we cannot trust"
 * (bad signature, or a body that is not valid JSON). These become HTTP 400.
 */
function isClientVerificationError(err) {
  return (
    (err && err.type === 'StripeSignatureVerificationError') ||
    err instanceof SyntaxError
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Extract payment details                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pulls only the fields we need out of a checkout.session.completed event.
 * Anything not needed (name, address, phone, card data...) is deliberately
 * ignored so it can never end up in our logs.
 *
 * Fields can legitimately be null: for example Stripe only knows the customer
 * e-mail if the customer typed one in at checkout.
 *
 * NOTE: amount_total is in the SMALLEST currency unit (cents for USD),
 * so 2000 means $20.00.
 */
function extractCheckoutDetails(event) {
  const session = (event && event.data && event.data.object) || {};

  // payment_intent is normally a string ID, but can be an expanded object.
  let paymentIntentId = null;
  if (typeof session.payment_intent === 'string') {
    paymentIntentId = session.payment_intent;
  } else if (session.payment_intent && session.payment_intent.id) {
    paymentIntentId = session.payment_intent.id;
  }

  // customer_details.email is the e-mail entered at checkout;
  // customer_email is the one the merchant pre-filled when creating the session.
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  return {
    event_id: event.id,
    event_type: event.type,
    checkout_session_id: session.id || null,
    payment_intent_id: paymentIntentId,
    customer_email: email, // FULL e-mail. Always pass through applyEmailPolicy() before logging or sending.
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || null,
    payment_status: session.payment_status || null,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. E-mail privacy helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * "john.doe@example.com" -> "j***@example.com"
 * Keeps the first character and the domain so support staff can still
 * recognise the customer, without storing the full address.
 */
function maskEmail(email) {
  if (typeof email !== 'string' || email.length === 0) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***'; // not a valid-looking e-mail, reveal nothing
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Returns a COPY of the details with the e-mail either masked (default) or
 * left in full (only when the matching opt-in env variable is "true").
 */
function applyEmailPolicy(details, allowFullEmail) {
  return {
    ...details,
    customer_email: allowFullEmail ? details.customer_email : maskEmail(details.customer_email),
  };
}

/** Reads a true/false environment variable. Anything except "true" is false. */
function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

/* -------------------------------------------------------------------------- */
/* 5. Duplicate event detection                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stripe may deliver the same event more than once (retries, network issues).
 * We remember event IDs we already handled so we do not log/forward twice.
 *
 * LIMITATION: this store lives in memory. It is emptied when the server
 * restarts and it is NOT shared between several server instances.
 *
 * HOW TO UPGRADE: the interface is just two async methods, has(id) and
 * add(id). To use Redis or a database, write a class with the same two
 * methods and call setEventStore(new MyRedisEventStore()) in server.js.
 * Nothing in the route has to change.
 *
 *   class RedisEventStore {
 *     async has(id) { return (await redis.exists(`stripe:evt:${id}`)) === 1; }
 *     async add(id) { await redis.set(`stripe:evt:${id}`, '1', 'EX', 7 * 24 * 3600); }
 *   }
 */
class InMemoryEventStore {
  /** @param {number} maxEntries oldest IDs are dropped after this many (keeps memory bounded) */
  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
    this.ids = new Set(); // a Set remembers insertion order
  }

  async has(eventId) {
    return this.ids.has(eventId);
  }

  async add(eventId) {
    this.ids.add(eventId);
    if (this.ids.size > this.maxEntries) {
      const oldest = this.ids.values().next().value;
      this.ids.delete(oldest);
    }
  }
}

let eventStore = new InMemoryEventStore();

function getEventStore() {
  return eventStore;
}

/** Swap in a different store (persistent storage, or a fresh one in tests). */
function setEventStore(store) {
  eventStore = store;
}

module.exports = {
  WebhookConfigError,
  getStripeClient,
  assertTestModeKey,
  verifyWebhookEvent,
  isClientVerificationError,
  extractCheckoutDetails,
  maskEmail,
  applyEmailPolicy,
  envFlag,
  InMemoryEventStore,
  getEventStore,
  setEventStore,
};
