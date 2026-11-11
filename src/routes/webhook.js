'use strict';

/**
 * routes/webhook.js
 * ----------------------------------------------------------------------------
 * POST /webhook : receives events from Stripe.
 *
 * Step by step, for every request:
 *   1. Read the RAW body (express.raw). Stripe signs the exact bytes, so the
 *      body must not be parsed before verification.
 *   2. Verify the Stripe-Signature header. Bad signature -> HTTP 400.
 *   3. Ignore live-mode events (this project is test mode only).
 *   4. Ignore events we do not handle (HTTP 200 so Stripe stops retrying).
 *   5. Skip duplicates (HTTP 200).
 *   6. Extract the payment fields and write them to the JSONL log.
 *      If the log cannot be written -> HTTP 500 so Stripe retries later.
 *   7. Optionally forward to the external API. Even if forwarding FAILS we
 *      still answer 200, because the event is verified and safely logged.
 *      Answering 500 would make Stripe re-send it and create duplicates.
 */

const express = require('express');
const logger = require('../services/logger');
const {
  WebhookConfigError,
  verifyWebhookEvent,
  isClientVerificationError,
  extractCheckoutDetails,
  applyEmailPolicy,
  envFlag,
  getEventStore,
} = require('../services/stripeService');
const { forwardPayment } = require('../services/forwardService');

const router = express.Router();

const HANDLED_EVENT_TYPE = 'checkout.session.completed';

// express.raw() is applied to THIS route only. Never put express.json() in
// front of it, because that would break signature verification.
const rawJson = express.raw({ type: 'application/json', limit: '1mb' });

router.post('/', rawJson, async (req, res, next) => {
  try {
    // --- 1. Basic request checks ------------------------------------------
    // If the Content-Type was not application/json, express.raw leaves req.body
    // as something other than a Buffer. Reject it clearly.
    if (!Buffer.isBuffer(req.body)) {
      await logger.safeLogEvent({
        level: 'warn',
        record_type: 'webhook_rejected',
        reason: 'body_not_raw_json',
      });
      return res.status(400).json({ error: 'Request body must be JSON with Content-Type: application/json.' });
    }

    const signature = req.get('stripe-signature');
    if (!signature) {
      await logger.safeLogEvent({
        level: 'warn',
        record_type: 'webhook_rejected',
        reason: 'missing_signature_header',
      });
      return res.status(400).json({ error: 'Missing Stripe-Signature header.' });
    }

    // --- 2. Verify the signature ------------------------------------------
    let event;
    try {
      event = verifyWebhookEvent(req.body, signature);
    } catch (err) {
      if (err instanceof WebhookConfigError) throw err; // our fault -> 500 via errorHandler
      if (isClientVerificationError(err)) {
        // Log only a reason code. Never log the signature, the body or the secret.
        await logger.safeLogEvent({
          level: 'warn',
          record_type: 'webhook_rejected',
          reason: 'invalid_signature',
        });
        return res.status(400).json({ error: 'Invalid Stripe signature.' });
      }
      throw err;
    }

    // From here on the event is genuine (verified by Stripe's SDK).

    // --- 3. Test mode only ------------------------------------------------
    if (event.livemode === true) {
      await logger.safeLogEvent({
        level: 'warn',
        record_type: 'event_ignored',
        reason: 'live_mode_not_accepted',
        event_id: event.id,
        event_type: event.type,
      });
      return res.status(200).json({ received: true, handled: false, reason: 'live_mode_not_accepted' });
    }

    // --- 4. Unsupported event types ---------------------------------------
    if (event.type !== HANDLED_EVENT_TYPE) {
      await logger.safeLogEvent({
        level: 'info',
        record_type: 'event_ignored',
        reason: 'unsupported_event_type',
        event_id: event.id,
        event_type: event.type,
      });
      return res.status(200).json({ received: true, handled: false, reason: 'unsupported_event_type' });
    }

    // --- 5. Duplicate detection -------------------------------------------
    const store = getEventStore();
    if (await store.has(event.id)) {
      await logger.safeLogEvent({
        level: 'info',
        record_type: 'event_duplicate',
        event_id: event.id,
        event_type: event.type,
      });
      return res.status(200).json({ received: true, handled: false, duplicate: true });
    }

    // --- 6. Extract + log -------------------------------------------------
    const details = extractCheckoutDetails(event);
    const loggable = applyEmailPolicy(details, envFlag('LOG_FULL_EMAIL'));

    // If this throws, the error handler answers 500 and Stripe will retry.
    await logger.logEvent({
      level: 'info',
      record_type: 'checkout_session_completed',
      ...loggable,
    });

    // Remember the event only AFTER it was safely logged.
    await store.add(event.id);

    // --- 7. Optional forwarding -------------------------------------------
    const forwardable = applyEmailPolicy(details, envFlag('FORWARD_FULL_EMAIL'));
    const result = await forwardPayment(forwardable);

    let forwarding = 'disabled';
    if (result.success) {
      forwarding = 'succeeded';
      await logger.safeLogEvent({
        level: 'info',
        record_type: 'forwarding_succeeded',
        event_id: event.id,
        status_code: result.status_code,
        duration_ms: result.duration_ms,
        target_host: result.target_host,
      });
    } else if (result.attempted || result.error_type === 'config') {
      forwarding = 'failed';
      await logger.logForwardingError({
        event_id: event.id,
        checkout_session_id: details.checkout_session_id,
        error_type: result.error_type,
        status_code: result.status_code,
        message: result.message,
        duration_ms: result.duration_ms,
        target_host: result.target_host,
      });
    }

    // The event is verified and logged, so we always tell Stripe "got it".
    return res.status(200).json({ received: true, handled: true, forwarding });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
