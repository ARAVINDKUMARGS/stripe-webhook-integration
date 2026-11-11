'use strict';

/**
 * Automated tests. Run with:  npm test
 *
 * How the tests work (no real Stripe account or internet needed):
 *   - The Express app is started on a random free port.
 *   - Webhook requests are signed with the Stripe SDK's own test helper
 *     (stripe.webhooks.generateTestHeaderString) using a FAKE secret. That
 *     produces a signature in exactly the format Stripe uses, so the REAL
 *     verification code path (constructEvent) is exercised.
 *   - A tiny local HTTP server plays the role of the client's external API,
 *     so we can test success, 4xx, 5xx, redirect, timeout and network errors.
 *   - Every test gets its own empty log folder and an empty duplicate store.
 *
 * What these tests do NOT prove: that Stripe's real servers can reach your
 * machine. That is tested manually with the Stripe CLI (see README.md).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Fake credentials, set BEFORE the app modules are loaded.
const TEST_SECRET = 'whsec_test_secret_for_automated_tests';
const TEST_KEY = 'sk_test_dummy_key_for_automated_tests';
process.env.STRIPE_SECRET_KEY = TEST_KEY;
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;

const Stripe = require('stripe');
const { createApp, validateStartupConfig } = require('../src/server');
const stripeService = require('../src/services/stripeService');
const forwardService = require('../src/services/forwardService');

const stripe = new Stripe(TEST_KEY);

/* ----------------------------- test helpers ------------------------------ */

let server;
let baseUrl;
let logDir;
let eventCounter = 0;

const FORWARD_VARS = [
  'FORWARD_ENABLED', 'FORWARD_URL', 'FORWARD_METHOD', 'FORWARD_TIMEOUT_MS',
  'FORWARD_AUTH_HEADER_NAME', 'FORWARD_AUTH_HEADER_VALUE', 'FORWARD_FULL_EMAIL', 'LOG_FULL_EMAIL',
];

/** Builds a realistic (trimmed) checkout.session.completed event. */
function makeCheckoutEvent({ id, livemode = false, type = 'checkout.session.completed', session = {} } = {}) {
  eventCounter += 1;
  return {
    id: id || `evt_test_${eventCounter}`,
    object: 'event',
    api_version: '2025-01-01',
    created: Math.floor(Date.now() / 1000),
    livemode,
    type,
    data: {
      object: {
        id: `cs_test_${eventCounter}`,
        object: 'checkout.session',
        amount_total: 2000,
        currency: 'usd',
        payment_status: 'paid',
        payment_intent: `pi_test_${eventCounter}`,
        customer_email: null,
        // Name and address are included on purpose: the tests prove they are NOT logged.
        customer_details: {
          email: 'jane.doe@example.com',
          name: 'Jane Doe',
          address: { city: 'Test City', line1: '1 Private Street' },
        },
        ...session,
      },
    },
  };
}

/** Sends a correctly signed webhook request to the app. */
async function sendWebhook(event, { secret = TEST_SECRET, headers = {}, signatureOverride, payloadOverride, timestamp } = {}) {
  const payload = payloadOverride !== undefined ? payloadOverride : JSON.stringify(event);
  const signature =
    signatureOverride !== undefined
      ? signatureOverride
      : stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret, ...(timestamp ? { timestamp } : {}) });

  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (signature !== null) reqHeaders['Stripe-Signature'] = signature;

  const res = await fetch(`${baseUrl}/webhook`, { method: 'POST', headers: reqHeaders, body: payload });
  return { status: res.status, body: await res.json() };
}

/** Reads a .jsonl log file and returns an array of objects ([] if missing). */
function readLog(fileName) {
  const file = path.join(logDir, fileName);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readLogRaw(fileName) {
  const file = path.join(logDir, fileName);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** A tiny fake "client API" that records every request it receives. */
function startMockApi(handler) {
  const requests = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, body });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${mock.address().port}/ingest`,
        requests,
        close: () => new Promise((r) => { mock.closeAllConnections(); mock.close(() => r()); }),
      });
    });
  });
}

function enableForwarding(url, extra = {}) {
  process.env.FORWARD_ENABLED = 'true';
  process.env.FORWARD_URL = url;
  Object.assign(process.env, extra);
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  FORWARD_VARS.forEach((v) => delete process.env[v]);
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-test-logs-'));
  process.env.LOG_DIR = logDir;
  stripeService.setEventStore(new stripeService.InMemoryEventStore());
});

/* -------------------------------------------------------------------------- */
/* Health check and routing                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /health and routing', () => {
  it('returns 200 and status "ok"', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime_seconds, 'number');
  });

  it('does not reveal that Express is used (no X-Powered-By header)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('returns a JSON 404 for unknown URLs', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
  });

  it('returns 404 for GET /webhook (only POST is allowed)', async () => {
    const res = await fetch(`${baseUrl}/webhook`);
    assert.equal(res.status, 404);
  });
});

/* -------------------------------------------------------------------------- */
/* Signature verification                                                     */
/* -------------------------------------------------------------------------- */

describe('POST /webhook - signature verification', () => {
  it('accepts a correctly signed checkout.session.completed event (200)', async () => {
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, handled: true, forwarding: 'disabled' });
  });

  it('rejects a signature made with the wrong secret (400)', async () => {
    const res = await sendWebhook(makeCheckoutEvent(), { secret: 'whsec_some_other_secret' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid Stripe signature.' });
    assert.equal(readLog('webhook-events.jsonl').filter((r) => r.record_type === 'checkout_session_completed').length, 0);
  });

  it('rejects a made-up signature (400)', async () => {
    const res = await sendWebhook(makeCheckoutEvent(), { signatureOverride: 't=1700000000,v1=deadbeef' });
    assert.equal(res.status, 400);
  });

  it('rejects a payload that was changed after signing (400)', async () => {
    const event = makeCheckoutEvent();
    const tampered = JSON.stringify({ ...event, data: { object: { ...event.data.object, amount_total: 1 } } });
    const res = await sendWebhook(event, { payloadOverride: tampered });
    assert.equal(res.status, 400);
  });

  it('rejects an old signature timestamp - replay protection (400)', async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await sendWebhook(makeCheckoutEvent(), { timestamp: tenMinutesAgo });
    assert.equal(res.status, 400);
  });

  it('rejects a request with no Stripe-Signature header (400)', async () => {
    const res = await sendWebhook(makeCheckoutEvent(), { signatureOverride: null });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Missing Stripe-Signature header.' });
  });

  it('rejects a request that is not application/json (400)', async () => {
    const event = makeCheckoutEvent();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Stripe-Signature': 't=1,v1=abc' },
      body: JSON.stringify(event),
    });
    assert.equal(res.status, 400);
  });

  it('never writes the signature, secret or raw body to the logs', async () => {
    const event = makeCheckoutEvent();
    await sendWebhook(event, { secret: 'whsec_wrong_secret_value' });
    await sendWebhook(event);
    const raw = readLogRaw('webhook-events.jsonl');
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes('v1='), 'signature must not be logged');
    assert.ok(!raw.includes(TEST_SECRET), 'webhook secret must not be logged');
    assert.ok(!raw.includes('whsec_wrong_secret_value'), 'secret must not be logged');
    assert.ok(!raw.includes(TEST_KEY), 'API key must not be logged');
  });

  it('answers 500 (not 400) when the server has no webhook secret configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal server error.' });
    // The client must not learn which setting is missing.
    assert.ok(!JSON.stringify(res.body).includes('STRIPE_WEBHOOK_SECRET'));
  });
});

/* -------------------------------------------------------------------------- */
/* Event handling, extraction, logging                                        */
/* -------------------------------------------------------------------------- */

describe('POST /webhook - event handling and logging', () => {
  it('extracts and logs all required fields as one JSON line', async () => {
    const event = makeCheckoutEvent({ id: 'evt_test_extract' });
    const res = await sendWebhook(event);
    assert.equal(res.status, 200);

    const records = readLog('webhook-events.jsonl').filter((r) => r.record_type === 'checkout_session_completed');
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.event_id, 'evt_test_extract');
    assert.equal(rec.event_type, 'checkout.session.completed');
    assert.equal(rec.checkout_session_id, event.data.object.id);
    assert.equal(rec.payment_intent_id, event.data.object.payment_intent);
    assert.equal(rec.amount_total, 2000);
    assert.equal(rec.currency, 'usd');
    assert.equal(rec.payment_status, 'paid');
    assert.equal(rec.level, 'info');
    assert.ok(!Number.isNaN(Date.parse(rec.timestamp)), 'timestamp must be a valid date');
  });

  it('masks the customer e-mail by default and logs no name or address', async () => {
    await sendWebhook(makeCheckoutEvent());
    const raw = readLogRaw('webhook-events.jsonl');
    const rec = readLog('webhook-events.jsonl').find((r) => r.record_type === 'checkout_session_completed');
    assert.equal(rec.customer_email, 'j***@example.com');
    assert.ok(!raw.includes('jane.doe'), 'full e-mail must not appear');
    assert.ok(!raw.includes('Jane Doe'), 'customer name must not appear');
    assert.ok(!raw.includes('Test City'), 'address must not appear');
    assert.ok(!raw.includes('1 Private Street'), 'address must not appear');
  });

  it('logs the full e-mail only when LOG_FULL_EMAIL=true', async () => {
    process.env.LOG_FULL_EMAIL = 'true';
    await sendWebhook(makeCheckoutEvent());
    const rec = readLog('webhook-events.jsonl').find((r) => r.record_type === 'checkout_session_completed');
    assert.equal(rec.customer_email, 'jane.doe@example.com');
  });

  it('handles a session with no e-mail and no payment intent (nulls)', async () => {
    const event = makeCheckoutEvent({ session: { customer_details: null, payment_intent: null } });
    const res = await sendWebhook(event);
    assert.equal(res.status, 200);
    const rec = readLog('webhook-events.jsonl').find((r) => r.record_type === 'checkout_session_completed');
    assert.equal(rec.customer_email, null);
    assert.equal(rec.payment_intent_id, null);
  });

  it('safely ignores unsupported event types (200, not logged as a payment)', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 200; res.end('{}'); });
    enableForwarding(mock.url);
    const res = await sendWebhook(makeCheckoutEvent({ type: 'payment_intent.succeeded' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, handled: false, reason: 'unsupported_event_type' });
    const records = readLog('webhook-events.jsonl');
    assert.equal(records.filter((r) => r.record_type === 'checkout_session_completed').length, 0);
    assert.equal(records.filter((r) => r.record_type === 'event_ignored').length, 1);
    assert.equal(mock.requests.length, 0, 'unsupported events must not be forwarded');
    await mock.close();
  });

  it('ignores live-mode events because this project is test mode only', async () => {
    const res = await sendWebhook(makeCheckoutEvent({ livemode: true }));
    assert.equal(res.status, 200);
    assert.equal(res.body.reason, 'live_mode_not_accepted');
    assert.equal(readLog('webhook-events.jsonl').filter((r) => r.record_type === 'checkout_session_completed').length, 0);
  });

  it('answers 500 when the log file cannot be written, and the same event can be retried', async () => {
    // Point LOG_DIR "inside a file" so creating the folder fails.
    const blocker = path.join(logDir, 'iam-a-file');
    fs.writeFileSync(blocker, 'x');
    process.env.LOG_DIR = path.join(blocker, 'logs');

    const event = makeCheckoutEvent({ id: 'evt_test_retry' });
    const first = await sendWebhook(event);
    assert.equal(first.status, 500);

    // Stripe would retry; once logging works again the event must be accepted.
    process.env.LOG_DIR = logDir;
    const second = await sendWebhook(event);
    assert.equal(second.status, 200);
    assert.equal(second.body.handled, true);
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate detection                                                        */
/* -------------------------------------------------------------------------- */

describe('duplicate event detection', () => {
  it('processes an event ID once and skips the repeat (logged once, forwarded once)', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 200; res.end('{}'); });
    enableForwarding(mock.url);

    const event = makeCheckoutEvent({ id: 'evt_test_dup' });
    const first = await sendWebhook(event);
    const second = await sendWebhook(event);

    assert.equal(first.status, 200);
    assert.equal(first.body.handled, true);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { received: true, handled: false, duplicate: true });

    const records = readLog('webhook-events.jsonl');
    assert.equal(records.filter((r) => r.record_type === 'checkout_session_completed').length, 1);
    assert.equal(records.filter((r) => r.record_type === 'event_duplicate').length, 1);
    assert.equal(mock.requests.length, 1, 'duplicate must not be forwarded again');
    await mock.close();
  });

  it('forgets IDs when the store is replaced (shows the restart limitation)', async () => {
    const event = makeCheckoutEvent({ id: 'evt_test_restart' });
    await sendWebhook(event);
    stripeService.setEventStore(new stripeService.InMemoryEventStore()); // simulates a server restart
    const again = await sendWebhook(event);
    assert.equal(again.body.handled, true, 'after a "restart" the duplicate is processed again');
  });

  it('InMemoryEventStore drops the oldest IDs when it is full', async () => {
    const store = new stripeService.InMemoryEventStore(2);
    await store.add('a');
    await store.add('b');
    await store.add('c');
    assert.equal(await store.has('a'), false);
    assert.equal(await store.has('b'), true);
    assert.equal(await store.has('c'), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Forwarding                                                                 */
/* -------------------------------------------------------------------------- */

describe('optional forwarding', () => {
  it('does nothing when FORWARD_ENABLED is not true', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 200; res.end(); });
    process.env.FORWARD_URL = mock.url; // URL set, but not enabled
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.body.forwarding, 'disabled');
    assert.equal(mock.requests.length, 0);
    await mock.close();
  });

  it('forwards the extracted fields as JSON, with auth header, e-mail masked', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 201; res.end('{}'); });
    enableForwarding(mock.url, {
      FORWARD_AUTH_HEADER_NAME: 'X-Api-Key',
      FORWARD_AUTH_HEADER_VALUE: 'test-secret-value',
    });

    const event = makeCheckoutEvent({ id: 'evt_test_forward' });
    const res = await sendWebhook(event);
    assert.equal(res.status, 200);
    assert.equal(res.body.forwarding, 'succeeded');

    assert.equal(mock.requests.length, 1);
    const sent = mock.requests[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.equal(sent.headers['x-api-key'], 'test-secret-value');
    assert.deepEqual(JSON.parse(sent.body), {
      event_id: 'evt_test_forward',
      event_type: 'checkout.session.completed',
      checkout_session_id: event.data.object.id,
      payment_intent_id: event.data.object.payment_intent,
      customer_email: 'j***@example.com',
      amount_total: 2000,
      currency: 'usd',
      payment_status: 'paid',
    });

    // Success is noted in the events log, and the auth value is never logged.
    const raw = readLogRaw('webhook-events.jsonl');
    assert.ok(raw.includes('forwarding_succeeded'));
    assert.ok(!raw.includes('test-secret-value'));
    assert.equal(readLog('forwarding-errors.jsonl').length, 0);
    await mock.close();
  });

  it('sends the full e-mail only when FORWARD_FULL_EMAIL=true', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 200; res.end(); });
    enableForwarding(mock.url, { FORWARD_FULL_EMAIL: 'true' });
    await sendWebhook(makeCheckoutEvent());
    assert.equal(JSON.parse(mock.requests[0].body).customer_email, 'jane.doe@example.com');
    // ...while the LOG still masks it, because LOG_FULL_EMAIL is separate.
    const rec = readLog('webhook-events.jsonl').find((r) => r.record_type === 'checkout_session_completed');
    assert.equal(rec.customer_email, 'j***@example.com');
    await mock.close();
  });

  it('supports PUT when FORWARD_METHOD=PUT', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 200; res.end(); });
    enableForwarding(mock.url, { FORWARD_METHOD: 'put' });
    await sendWebhook(makeCheckoutEvent());
    assert.equal(mock.requests[0].method, 'PUT');
    await mock.close();
  });

  it('still answers 200 and logs a separate error when the external API returns 500', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 500; res.end('boom'); });
    enableForwarding(mock.url);
    const res = await sendWebhook(makeCheckoutEvent({ id: 'evt_test_fwd500' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.forwarding, 'failed');
    const errors = readLog('forwarding-errors.jsonl');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error_type, 'server_error');
    assert.equal(errors[0].status_code, 500);
    assert.equal(errors[0].event_id, 'evt_test_fwd500');
    assert.equal(errors[0].record_type, 'forwarding_failed');
    // The payment itself is still safely logged.
    assert.equal(readLog('webhook-events.jsonl').filter((r) => r.record_type === 'checkout_session_completed').length, 1);
    await mock.close();
  });

  it('classifies a 4xx answer as client_error and a 429 as rate_limited', async () => {
    let status = 400;
    const mock = await startMockApi((req, res) => { res.statusCode = status; res.end(); });
    enableForwarding(mock.url);
    await sendWebhook(makeCheckoutEvent());
    status = 429;
    await sendWebhook(makeCheckoutEvent());
    const errors = readLog('forwarding-errors.jsonl');
    assert.deepEqual(errors.map((e) => e.error_type), ['client_error', 'rate_limited']);
    await mock.close();
  });

  it('does not follow redirects (error_type redirect)', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:9/elsewhere'); res.end(); });
    enableForwarding(mock.url);
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.status, 200);
    assert.equal(readLog('forwarding-errors.jsonl')[0].error_type, 'redirect');
    assert.equal(mock.requests.length, 1);
    await mock.close();
  });

  it('times out slow external APIs, then still answers 200', async () => {
    const mock = await startMockApi(() => { /* never answers */ });
    enableForwarding(mock.url, { FORWARD_TIMEOUT_MS: '300' });
    const started = Date.now();
    const res = await sendWebhook(makeCheckoutEvent());
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    assert.equal(res.body.forwarding, 'failed');
    assert.equal(readLog('forwarding-errors.jsonl')[0].error_type, 'timeout');
    assert.ok(elapsed < 3000, `should give up quickly, took ${elapsed} ms`);
    await mock.close();
  });

  it('reports a network error when the external API is unreachable', async () => {
    enableForwarding('http://127.0.0.1:1/ingest', { FORWARD_TIMEOUT_MS: '2000' });
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.status, 200);
    assert.equal(readLog('forwarding-errors.jsonl')[0].error_type, 'network');
  });

  it('reports a config error (but still answers 200) when forwarding is enabled without a URL', async () => {
    process.env.FORWARD_ENABLED = 'true';
    const res = await sendWebhook(makeCheckoutEvent());
    assert.equal(res.status, 200);
    assert.equal(res.body.forwarding, 'failed');
    assert.equal(readLog('forwarding-errors.jsonl')[0].error_type, 'config');
  });

  it('logs only the host of the target, never the full URL or query string', async () => {
    const mock = await startMockApi((req, res) => { res.statusCode = 500; res.end(); });
    enableForwarding(`${mock.url}?token=super-secret-token`);
    await sendWebhook(makeCheckoutEvent());
    const raw = readLogRaw('forwarding-errors.jsonl');
    assert.ok(raw.includes('127.0.0.1'));
    assert.ok(!raw.includes('super-secret-token'));
    await mock.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Unit tests for helpers                                                     */
/* -------------------------------------------------------------------------- */

describe('helper functions', () => {
  it('maskEmail keeps the first letter and the domain', () => {
    assert.equal(stripeService.maskEmail('john.doe@example.com'), 'j***@example.com');
    assert.equal(stripeService.maskEmail('a@b.io'), 'a***@b.io');
    assert.equal(stripeService.maskEmail('not-an-email'), '***');
    assert.equal(stripeService.maskEmail(''), null);
    assert.equal(stripeService.maskEmail(null), null);
  });

  it('extractCheckoutDetails handles an expanded payment_intent object and customer_email fallback', () => {
    const event = makeCheckoutEvent({
      session: { payment_intent: { id: 'pi_expanded_1' }, customer_details: null, customer_email: 'prefilled@example.com' },
    });
    const d = stripeService.extractCheckoutDetails(event);
    assert.equal(d.payment_intent_id, 'pi_expanded_1');
    assert.equal(d.customer_email, 'prefilled@example.com');
  });

  it('assertTestModeKey accepts test keys and rejects live keys', () => {
    assert.doesNotThrow(() => stripeService.assertTestModeKey('sk_test_abc'));
    assert.doesNotThrow(() => stripeService.assertTestModeKey('rk_test_abc'));
    assert.throws(() => stripeService.assertTestModeKey('sk_live_abc'), /TEST key/);
    assert.throws(() => stripeService.assertTestModeKey(''), /TEST key/);
  });

  it('validateStartupConfig reports missing, live and malformed settings', () => {
    const saved = { k: process.env.STRIPE_SECRET_KEY, s: process.env.STRIPE_WEBHOOK_SECRET };
    try {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      assert.equal(validateStartupConfig().length, 2);

      process.env.STRIPE_SECRET_KEY = 'sk_live_not_allowed';
      process.env.STRIPE_WEBHOOK_SECRET = 'not_a_whsec';
      assert.equal(validateStartupConfig().length, 2);

      process.env.STRIPE_SECRET_KEY = 'sk_test_ok';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ok';
      assert.deepEqual(validateStartupConfig(), []);
    } finally {
      process.env.STRIPE_SECRET_KEY = saved.k;
      process.env.STRIPE_WEBHOOK_SECRET = saved.s;
    }
  });

  it('classifyStatus maps HTTP codes to categories', () => {
    const c = forwardService.classifyStatus;
    assert.equal(c(200), 'success');
    assert.equal(c(204), 'success');
    assert.equal(c(301), 'redirect');
    assert.equal(c(404), 'client_error');
    assert.equal(c(429), 'rate_limited');
    assert.equal(c(503), 'server_error');
  });

  it('validateConfig rejects bad URLs, bad methods and half-set auth headers', () => {
    const base = { url: 'https://api.example.com/x', method: 'POST', authHeaderName: '', authHeaderValue: '' };
    assert.equal(forwardService.validateConfig(base), null);
    assert.match(forwardService.validateConfig({ ...base, url: '' }), /FORWARD_URL/);
    assert.match(forwardService.validateConfig({ ...base, url: 'not a url' }), /valid URL/);
    assert.match(forwardService.validateConfig({ ...base, url: 'ftp://x.com' }), /http/);
    assert.match(forwardService.validateConfig({ ...base, method: 'DELETE' }), /FORWARD_METHOD/);
    assert.match(forwardService.validateConfig({ ...base, authHeaderName: 'X-Key' }), /AUTH_HEADER/);
  });
});
