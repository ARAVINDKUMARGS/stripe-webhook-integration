'use strict';

/**
 * forwardService.js
 * ----------------------------------------------------------------------------
 * OPTIONAL step: send the extracted payment details to an external API.
 *
 * IMPORTANT: the client has NOT given us their API URL or JSON schema, so
 * nothing here is invented. Everything is controlled by environment variables:
 *
 *   FORWARD_ENABLED            "true" to turn forwarding on (default: off)
 *   FORWARD_URL                full URL of the client's endpoint
 *   FORWARD_METHOD             POST (default), PUT or PATCH
 *   FORWARD_TIMEOUT_MS         give up after this many ms (default 5000)
 *   FORWARD_AUTH_HEADER_NAME   optional, e.g. "Authorization" or "X-Api-Key"
 *   FORWARD_AUTH_HEADER_VALUE  optional, the secret value for that header
 *
 * The forwarding function NEVER throws. It always returns a result object, so
 * a forwarding problem can never break the webhook response to Stripe.
 */

const ALLOWED_METHODS = ['POST', 'PUT', 'PATCH'];
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30000;

/**
 * Builds the JSON body sent to the external API.
 *
 * DEFAULT: the extracted fields exactly as listed in the project brief.
 * >>> When the client confirms their real schema, change ONLY this function. <<<
 */
function buildForwardPayload(details) {
  return {
    event_id: details.event_id,
    event_type: details.event_type,
    checkout_session_id: details.checkout_session_id,
    payment_intent_id: details.payment_intent_id,
    customer_email: details.customer_email,
    amount_total: details.amount_total,
    currency: details.currency,
    payment_status: details.payment_status,
  };
}

/** Reads and validates the forwarding settings from the environment. */
function getForwardConfig() {
  const enabled = String(process.env.FORWARD_ENABLED || '').trim().toLowerCase() === 'true';
  const url = (process.env.FORWARD_URL || '').trim();
  const method = (process.env.FORWARD_METHOD || 'POST').trim().toUpperCase();

  let timeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS, 10);
  if (Number.isNaN(timeoutMs)) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

  return {
    enabled,
    url,
    method,
    timeoutMs,
    authHeaderName: (process.env.FORWARD_AUTH_HEADER_NAME || '').trim(),
    authHeaderValue: process.env.FORWARD_AUTH_HEADER_VALUE || '',
  };
}

/** Returns a problem description if the settings are unusable, otherwise null. */
function validateConfig(cfg) {
  if (!cfg.url) return 'FORWARD_ENABLED is true but FORWARD_URL is empty.';
  let parsed;
  try {
    parsed = new URL(cfg.url);
  } catch {
    return 'FORWARD_URL is not a valid URL.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'FORWARD_URL must start with http:// or https://.';
  }
  if (!ALLOWED_METHODS.includes(cfg.method)) {
    return `FORWARD_METHOD must be one of: ${ALLOWED_METHODS.join(', ')}.`;
  }
  if (cfg.authHeaderName && !cfg.authHeaderValue) {
    return 'FORWARD_AUTH_HEADER_NAME is set but FORWARD_AUTH_HEADER_VALUE is empty.';
  }
  return null;
}

/**
 * Turns an HTTP status code into a simple category so logs are easy to read:
 *   2xx -> success
 *   3xx -> redirect       (we do not follow redirects, so the URL needs fixing)
 *   429 -> rate_limited   (client API is busy; retrying later may work)
 *   4xx -> client_error   (our payload or credentials were rejected)
 *   5xx -> server_error   (client API is broken; retrying later may work)
 */
function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'unexpected_status';
}

/**
 * Sends the details to the external API.
 *
 * @param {object} details Extracted checkout details (e-mail already masked or
 *                         full according to FORWARD_FULL_EMAIL).
 * @returns {Promise<object>} One of:
 *   { attempted: false, success: false, reason: 'disabled' }
 *   { attempted: false, success: false, error_type: 'config', message }
 *   { attempted: true,  success: true,  status_code, duration_ms, target_host }
 *   { attempted: true,  success: false, error_type, status_code?, message, duration_ms, target_host }
 *   where error_type is: timeout | network | redirect | rate_limited |
 *                        client_error | server_error | unexpected_status
 */
async function forwardPayment(details) {
  const cfg = getForwardConfig();

  if (!cfg.enabled) {
    return { attempted: false, success: false, reason: 'disabled' };
  }

  const configProblem = validateConfig(cfg);
  if (configProblem) {
    return { attempted: false, success: false, error_type: 'config', message: configProblem };
  }

  // Only the host is logged, never the full URL (URLs can contain secrets).
  const targetHost = new URL(cfg.url).host;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.authHeaderName) headers[cfg.authHeaderName] = cfg.authHeaderValue;

  // AbortController lets us cancel the request if it takes too long.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(cfg.url, {
      method: cfg.method,
      headers,
      body: JSON.stringify(buildForwardPayload(details)),
      signal: controller.signal,
      redirect: 'manual', // never follow redirects (could leak the auth header elsewhere)
    });

    // We only care about the status code, so discard the response body.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }

    const category = classifyStatus(response.status);
    const durationMs = Date.now() - startedAt;

    if (category === 'success') {
      return { attempted: true, success: true, status_code: response.status, duration_ms: durationMs, target_host: targetHost };
    }
    return {
      attempted: true,
      success: false,
      error_type: category,
      status_code: response.status,
      message: `External API answered with HTTP ${response.status}.`,
      duration_ms: durationMs,
      target_host: targetHost,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err && err.name === 'AbortError') {
      return {
        attempted: true,
        success: false,
        error_type: 'timeout',
        message: `External API did not answer within ${cfg.timeoutMs} ms.`,
        duration_ms: durationMs,
        target_host: targetHost,
      };
    }
    // DNS failure, connection refused, TLS error, etc.
    const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    return {
      attempted: true,
      success: false,
      error_type: 'network',
      message: `Could not reach the external API${cause}.`,
      duration_ms: durationMs,
      target_host: targetHost,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildForwardPayload, getForwardConfig, validateConfig, classifyStatus, forwardPayment };
