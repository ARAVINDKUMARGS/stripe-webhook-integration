'use strict';

/**
 * logger.js
 * ----------------------------------------------------------------------------
 * Writes structured logs in JSONL format ("JSON Lines"): one complete JSON
 * object per line. This format is easy to read with tools like `jq`, easy to
 * append to, and easy to import into other systems later.
 *
 * Two files are written inside the log folder:
 *   - webhook-events.jsonl     : webhook activity (processed, ignored,
 *                                duplicate, signature failures, server errors)
 *   - forwarding-errors.jsonl  : ONLY failed attempts to forward data to the
 *                                external API (kept separate on purpose)
 *
 * PRIVACY RULES followed by this module:
 *   - Never pass the raw request body, the Stripe-Signature header, API keys
 *     or the webhook secret to these functions.
 *   - Callers only pass the small set of extracted fields, with the e-mail
 *     already masked (see stripeService.applyEmailPolicy).
 */

const fs = require('fs/promises');
const path = require('path');

const EVENTS_FILE = 'webhook-events.jsonl';
const FORWARD_ERRORS_FILE = 'forwarding-errors.jsonl';

/** Log folder: LOG_DIR from the environment, or <project>/logs by default. */
function getLogDir() {
  return process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.resolve(__dirname, '..', '..', 'logs');
}

/** Appends one JSON object as one line to the given log file. */
async function appendLine(fileName, record) {
  const dir = getLogDir();
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
  await fs.appendFile(path.join(dir, fileName), line + '\n', 'utf8');
  return line;
}

/**
 * Logs a webhook event record to webhook-events.jsonl AND the console.
 * Throws if the file cannot be written, so the caller can respond with
 * HTTP 500 and let Stripe retry (we never want to lose a payment record
 * silently).
 */
async function logEvent(record) {
  const line = await appendLine(EVENTS_FILE, record);
  console.log(line);
}

/**
 * Same as logEvent, but NEVER throws. Use this for records that are nice to
 * have (for example "signature check failed") where a logging problem must not
 * change the HTTP response.
 */
async function safeLogEvent(record) {
  try {
    await logEvent(record);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Could not write log file', reason: err.message }));
  }
}

/**
 * Logs a forwarding failure to forwarding-errors.jsonl AND the console.
 * Never throws: a failed forward must not turn into a failed webhook.
 */
async function logForwardingError(record) {
  try {
    const line = await appendLine(FORWARD_ERRORS_FILE, { level: 'error', record_type: 'forwarding_failed', ...record });
    console.error(line);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Could not write forwarding error log', reason: err.message }));
  }
}

module.exports = {
  EVENTS_FILE,
  FORWARD_ERRORS_FILE,
  getLogDir,
  logEvent,
  safeLogEvent,
  logForwardingError,
};
