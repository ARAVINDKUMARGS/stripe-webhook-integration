'use strict';

/**
 * middleware/errorHandler.js
 * ----------------------------------------------------------------------------
 * Two small Express middlewares:
 *   - notFoundHandler : answers unknown URLs with a clean JSON 404.
 *   - errorHandler    : the LAST middleware. Catches any error passed to
 *                       next(err) and returns a safe JSON response.
 *
 * SECURITY: the client only ever sees a generic message. Details (error name
 * and message) go to our own log. Stack traces and request bodies are never
 * sent to the client and never written to the log file.
 */

const logger = require('../services/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found.' });
}

// Express recognises an error handler by its 4 parameters. Keep all 4.
// eslint-disable-next-line no-unused-vars
async function errorHandler(err, req, res, next) {
  // If the response already started, we cannot send JSON any more.
  if (res.headersSent) {
    return next(err);
  }

  // Errors from Express itself (e.g. "payload too large") carry a 4xx status.
  const status =
    Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;

  await logger.safeLogEvent({
    level: 'error',
    record_type: 'server_error',
    status,
    error_name: err.name,
    error_message: err.message,
  });

  const message =
    status === 500 ? 'Internal server error.' : 'The request could not be processed.';
  return res.status(status).json({ error: message });
}

module.exports = { notFoundHandler, errorHandler };
