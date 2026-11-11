'use strict';

/**
 * server.js
 * ----------------------------------------------------------------------------
 * Entry point. Builds the Express app and starts listening.
 *
 *   createApp()   builds the app (also used by the automated tests)
 *   startServer() loads .env, checks the settings and starts listening
 *
 * The server only starts when this file is run directly (npm start).
 * When another file (like the tests) require()s it, nothing starts.
 */

const express = require('express');
const webhookRouter = require('./routes/webhook');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { assertTestModeKey, WebhookConfigError } = require('./services/stripeService');

function createApp() {
  const app = express();

  // Do not advertise that we use Express.
  app.disable('x-powered-by');

  // Health check: lets you (or a hosting platform) see that the server is up.
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'stripe-webhook-integration',
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // The webhook route. It sets up its OWN raw body parser.
  // WARNING: do NOT add app.use(express.json()) above this line. A JSON parser
  // would change the body and Stripe signature verification would always fail.
  app.use('/webhook', webhookRouter);

  app.use(notFoundHandler); // unknown URLs -> 404
  app.use(errorHandler);    // must be last

  return app;
}

/** Checks the required settings and stops with a friendly message if wrong. */
function validateStartupConfig() {
  const problems = [];

  if (!process.env.STRIPE_SECRET_KEY) {
    problems.push('STRIPE_SECRET_KEY is missing.');
  } else {
    try {
      assertTestModeKey(process.env.STRIPE_SECRET_KEY);
    } catch (err) {
      if (err instanceof WebhookConfigError) problems.push(err.message);
      else throw err;
    }
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    problems.push('STRIPE_WEBHOOK_SECRET is missing (run "stripe listen" to get a whsec_... value).');
  } else if (!secret.startsWith('whsec_')) {
    problems.push('STRIPE_WEBHOOK_SECRET should start with "whsec_".');
  }

  return problems;
}

function startServer() {
  require('dotenv').config({ quiet: true }); // loads .env into process.env (does not override real env vars)

  const problems = validateStartupConfig();
  if (problems.length > 0) {
    console.error('Cannot start the server. Please fix your .env file:');
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('See .env.example for the list of settings.');
    process.exit(1);
  }

  const port = parseInt(process.env.PORT, 10) || 3000;
  const server = createApp().listen(port, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'Server started (Stripe TEST mode)',
      port,
      webhook_url: `http://localhost:${port}/webhook`,
      forwarding_enabled: String(process.env.FORWARD_ENABLED || '').toLowerCase() === 'true',
    }));
  });

  // Shut down cleanly on Ctrl+C or when the host asks us to stop.
  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down` }));
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, validateStartupConfig };
