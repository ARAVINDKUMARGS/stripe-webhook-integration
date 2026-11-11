# Stripe Webhook Integration (Test Mode)

A small, secure **Node.js + Express** backend that receives Stripe webhooks, checks that they are genuine, and records `checkout.session.completed` payments in a structured log file. It can also (optionally) forward the payment details to another API.

- **Client:** Zenith SaaS Startup Global
- **Platform:** SkillNexa freelance project
- **Mode:** Stripe **test mode only** (the server refuses to start with a live key)
- **No frontend.** This is a backend API project.

---

## 1. What does it do? (in simple words)

When a customer finishes paying on a Stripe Checkout page, Stripe sends a message (a *webhook*) to your server. Your server must:

1. **Check the message is really from Stripe** (using the signature). Anyone could send fake messages otherwise.
2. **Pick out the useful details** (payment ID, amount, currency, status...).
3. **Write them to a log file** as one JSON line.
4. **Optionally pass them on** to another API.
5. **Reply quickly** so Stripe knows the message arrived.

```
Stripe ──POST /webhook──▶ [raw body] ─▶ [verify signature] ─▶ [extract fields]
                                              │ bad? → HTTP 400        │
                                                                       ▼
                                          [write JSONL log] ─▶ [optional forward] ─▶ HTTP 200
```

---

## 2. Project structure

```
stripe-webhook-integration/
├── src/
│   ├── server.js                 # builds the Express app, starts the server
│   ├── routes/
│   │   └── webhook.js            # POST /webhook (the main logic)
│   ├── services/
│   │   ├── stripeService.js      # signature check, field extraction, e-mail masking, duplicate store
│   │   ├── logger.js             # writes JSONL log files
│   │   └── forwardService.js     # optional forwarding with timeout
│   └── middleware/
│       └── errorHandler.js       # safe JSON errors and 404
├── tests/
│   └── webhook.test.js           # automated tests (40 tests)
├── logs/
│   └── .gitkeep                  # keeps the folder in Git (log files are git-ignored)
├── postman/
│   └── stripe-webhook.postman_collection.json
├── docs/
│   └── technical-summary.md
├── .env.example                  # template for your settings (safe to commit)
├── .gitignore
├── package.json
└── README.md
```

> `tests/` is the only folder added to the structure in the brief. It holds the automated tests.

---

## 3. Requirements

- **Node.js 18.2 or newer** (developed and tested on Node 22). Check with `node --version`.
- **npm** (comes with Node.js)
- A free **Stripe account** (test mode) and the **Stripe CLI**
- **Postman** (optional, for the health check and rejection demos)
- **Git** and a **GitHub** account

---

## 4. Setup

```bash
# 1. Go into the project folder
cd stripe-webhook-integration

# 2. Install the dependencies (express, stripe, dotenv)
npm install

# 3. Create your private settings file
cp .env.example .env        # Windows (PowerShell): Copy-Item .env.example .env
```

Now open `.env` and fill in:

| Setting | What to put | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` | Stripe Dashboard → turn on **Test mode** → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Printed by `stripe listen` (see section 6) |

The other settings have safe defaults. **Never share `.env` and never commit it.**

---

## 5. Settings reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `STRIPE_SECRET_KEY` | *(required)* | Must start with `sk_test_` or `rk_test_`; live keys are refused |
| `STRIPE_WEBHOOK_SECRET` | *(required)* | Must start with `whsec_` |
| `LOG_DIR` | `./logs` | Folder for the log files |
| `LOG_FULL_EMAIL` | `false` | `true` = write the full customer e-mail to the log (default is masked: `j***@example.com`) |
| `FORWARD_ENABLED` | `false` | `true` = forward payments to the external API |
| `FORWARD_URL` | *(empty)* | The client's endpoint. **Not provided yet.** |
| `FORWARD_METHOD` | `POST` | `POST`, `PUT` or `PATCH` |
| `FORWARD_TIMEOUT_MS` | `5000` | Give up after this many milliseconds (allowed range 100–30000) |
| `FORWARD_AUTH_HEADER_NAME` / `_VALUE` | *(empty)* | Optional auth header, e.g. `Authorization` / `Bearer abc123` |
| `FORWARD_FULL_EMAIL` | `false` | `true` = send the full e-mail to the external API (default masked) |

---

## 6. Test with the Stripe CLI (the real signature test)

Open **three terminals**.

### Step A: Install the Stripe CLI (once)

- **macOS:** `brew install stripe/stripe-cli/stripe`
- **Windows:** `scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git` then `scoop install stripe`
- **Linux / other:** follow https://docs.stripe.com/stripe-cli/install

Check it: `stripe --version`

### Step B: Log in (once)

```bash
stripe login
```
It opens your browser. Confirm the pairing code and allow access. Make sure you are using a **test mode** account.

### Step C: Forward events and get the signing secret (Terminal 1)

```bash
stripe listen --forward-to localhost:3000/webhook
```
The CLI prints something like:

```
> Ready! You are using Stripe API Version [...]. Your webhook signing secret is whsec_xxxxxxxx (^C to quit)
```

Copy the `whsec_...` value into `.env` as `STRIPE_WEBHOOK_SECRET`. (You can also run `stripe listen --print-secret` to print just the secret.) Leave this terminal running.

> Optional: `stripe listen --events checkout.session.completed --forward-to localhost:3000/webhook` forwards only the event we handle.

### Step D: Start the server (Terminal 2)

```bash
npm start
```
Expected output:
```
{"level":"info","message":"Server started (Stripe TEST mode)","port":3000,"webhook_url":"http://localhost:3000/webhook","forwarding_enabled":false}
```
If you change `.env`, stop (Ctrl+C) and start again.

### Step E: Trigger a test event (Terminal 3)

```bash
stripe trigger checkout.session.completed
```

### Step F: Inspect the results

- **Terminal 1 (stripe listen)** shows each event and the response: `[200] POST http://localhost:3000/webhook`.
  `stripe trigger` creates several events (payment intent, charge, etc.). The server answers **200** to all of them but only *processes* `checkout.session.completed`; others are logged as `event_ignored`.
- **Terminal 2 (server)** prints the JSON log lines.
- **The log file:**
  ```bash
  cat logs/webhook-events.jsonl          # macOS / Linux
  type logs\webhook-events.jsonl         # Windows
  jq . logs/webhook-events.jsonl         # pretty print (if jq is installed)
  ```
  You should see a line like:
  ```json
  {"timestamp":"2026-11-11T10:00:00.000Z","level":"info","record_type":"checkout_session_completed","event_id":"evt_...","event_type":"checkout.session.completed","checkout_session_id":"cs_test_...","payment_intent_id":"pi_...","customer_email":"j***@example.com","amount_total":2000,"currency":"usd","payment_status":"paid"}
  ```
  Some fields (such as the e-mail) can be `null`; Stripe only knows the e-mail if one was entered at checkout.

**Replay test (duplicate detection):** in the Stripe Dashboard (test mode) → Developers → Events, or with `stripe events resend <event_id>`, resend the same event. The server answers 200 and logs `event_duplicate` instead of processing it twice.

---

## 7. Endpoints

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/health` | Is the server running? | `200 {"status":"ok",...}` |
| `POST` | `/webhook` | Receives Stripe events | see below |

`POST /webhook` responses:

| Situation | HTTP | Body |
|---|---|---|
| Valid `checkout.session.completed`, logged | **200** | `{"received":true,"handled":true,"forwarding":"disabled\|succeeded\|failed"}` |
| Valid event of another type | **200** | `{"received":true,"handled":false,"reason":"unsupported_event_type"}` |
| Event ID already processed | **200** | `{"received":true,"handled":false,"duplicate":true}` |
| Live-mode event (not accepted) | **200** | `{"received":true,"handled":false,"reason":"live_mode_not_accepted"}` |
| Wrong or fake signature, tampered body, expired timestamp | **400** | `{"error":"Invalid Stripe signature."}` |
| Missing `Stripe-Signature` header | **400** | `{"error":"Missing Stripe-Signature header."}` |
| Body is not `application/json` | **400** | `{"error":"Request body must be JSON with Content-Type: application/json."}` |
| Log file could not be written, or server settings missing | **500** | `{"error":"Internal server error."}` |

Why 200 for ignored/duplicate events? A non-2xx answer makes Stripe retry for days. We *received* them fine, so we say so.

---

## 8. Postman

1. Start the server (`npm start`).
2. In Postman: **Import** → choose `postman/stripe-webhook.postman_collection.json`.
3. The collection variable `baseUrl` is `http://localhost:3000` (change it if your port differs).
4. Run **1. Health Check** → expect **200**.
5. Run **2. Webhook - Unsigned/Simulated Event** → expect **400**.
6. Run **3. Missing Stripe-Signature Header** → expect **400**.
7. Item **4** is documentation only. Its saved examples show every response a genuine webhook can return.

> ### Why Postman can never get a 200 here
> Stripe's `Stripe-Signature` header is a cryptographic stamp made with a secret (`whsec_...`) and the exact request body and timestamp. A request you build by hand in Postman has no valid stamp, so verification **must** fail with 400. That is the security feature working. **A real signed event can only be produced by Stripe or the Stripe CLI**, so genuine verification is tested with `stripe listen` + `stripe trigger` (section 6).

---

## 9. Logging

Two JSON Lines files (one JSON object per line) are written into `logs/`:

| File | Contains |
|---|---|
| `webhook-events.jsonl` | Processed payments, ignored events, duplicates, rejected requests (reason only), server errors, forwarding successes |
| `forwarding-errors.jsonl` | **Only** failed forwarding attempts (error type, HTTP status, target *host*, event ID) |

**What is deliberately NOT logged:** the raw request body, the `Stripe-Signature` header, API keys, the webhook secret, customer name, address, phone, card details, and the full forwarding URL. E-mail is masked unless you opt in.

---

## 10. Optional forwarding to an external API

**The client has not provided an endpoint or a JSON schema, so nothing is invented.** Forwarding is **off** by default.

To turn it on once the client gives you the details, set in `.env`:
```
FORWARD_ENABLED=true
FORWARD_URL=https://client-api.example.com/their/path
FORWARD_AUTH_HEADER_NAME=Authorization
FORWARD_AUTH_HEADER_VALUE=Bearer their-token
```
Restart the server.

**Default payload:** the extracted fields exactly as listed in the project brief:
```json
{
  "event_id": "evt_...", "event_type": "checkout.session.completed",
  "checkout_session_id": "cs_test_...", "payment_intent_id": "pi_...",
  "customer_email": "j***@example.com", "amount_total": 2000,
  "currency": "usd", "payment_status": "paid"
}
```
**When the client confirms their real schema, edit only `buildForwardPayload()` in `src/services/forwardService.js`.**

Behaviour:
- Timeout (default 5 s), no redirects followed.
- Results are classified: `timeout`, `network`, `redirect`, `rate_limited` (429), `client_error` (4xx), `server_error` (5xx), `config`.
- **If forwarding fails, the webhook still answers 200** (the event is verified and logged, and an error is written to `forwarding-errors.jsonl`). Answering 500 would make Stripe re-send the event and create duplicates.
- Forwarding failures are **not retried automatically**. Check `forwarding-errors.jsonl`. A retry queue would be a sensible follow-up if the client needs guaranteed delivery.

---

## 11. Duplicate events

Stripe sometimes sends the same event twice. The server remembers processed event IDs and skips repeats.

**Limitation:** the memory is **in-process**. It is **lost when the server restarts** and **not shared** between multiple server copies. After a restart a duplicate could be processed again.

**Upgrade path:** the store has only two async methods, `has(id)` and `add(id)` (see `InMemoryEventStore` in `src/services/stripeService.js`, which includes a Redis example). Write a class with the same two methods (Redis, PostgreSQL, ...) and pass it to `setEventStore()`. No route code changes.

---

## 12. Automated tests

```bash
npm test
```
Runs 40 tests, with no internet or real Stripe account needed. The tests create correctly signed requests using the Stripe SDK's own test helper and a fake local "client API". They cover:

- health check, 404s, no `X-Powered-By` header
- valid signature → 200; wrong secret / fake / tampered / expired / missing signature / wrong content type → 400
- field extraction, nulls, e-mail masking and opt-in, no name or address in logs
- unsupported event types, live-mode events, log write failure → 500 then successful retry
- duplicate detection
- forwarding: success, auth header, PUT, 4xx, 429, 5xx, redirect, timeout, unreachable host, bad config, URL secrets not logged
- startup safety checks (live keys refused)

> These tests do **not** replace the Stripe CLI test in section 6, which proves that real Stripe events reach your machine and verify with your real signing secret.

---

## 13. Security notes

- Signature verified with `stripe.webhooks.constructEvent()` on the **raw** body; 5-minute timestamp tolerance (Stripe SDK default) blocks replayed messages.
- Secrets only from environment variables; `.env` is git-ignored; `.env.example` holds placeholders only.
- Test keys only: startup refuses live keys; live-mode events are ignored.
- Errors returned to callers are generic; details go only to the server log.
- Privacy by default: e-mail masked; no name/address/phone/card data is read or logged.
- Request size limit of 1 MB on the webhook route.
- **Not included (out of scope, recommended for production):** HTTPS (use a host/reverse proxy that provides it), rate limiting, persistent duplicate storage, log rotation, monitoring/alerts.

---

## 14. Publishing to GitHub

First check that no secrets will be uploaded:

```bash
cd stripe-webhook-integration
git init
git add .
git status                      # .env and node_modules must NOT be listed; .env.example SHOULD be
```

Create an **empty private repository** on GitHub (no README/.gitignore added by GitHub), then:

```bash
git commit -m "Add Stripe webhook integration (test mode)"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/stripe-webhook-integration.git
git push -u origin main
```

If Git asks who you are: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.

With the GitHub CLI instead: `gh repo create stripe-webhook-integration --private --source=. --push`

---

## 15. Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| Server stops with "Cannot start the server" | A setting is missing or wrong in `.env`. Read the listed problems. |
| Everything returns 400 "Invalid Stripe signature" | `STRIPE_WEBHOOK_SECRET` does not match the one printed by your current `stripe listen`. Copy it again and restart the server. |
| 400 even with the right secret | Something modified the body before the webhook route. Never add `express.json()` before `/webhook`. |
| Nothing arrives | Is `stripe listen` running and pointing to the same port as `PORT`? |
| `forwarding: "failed"` | Open `logs/forwarding-errors.jsonl` and read `error_type` and `message`. |
| Port already in use | Change `PORT` in `.env` and use the same port in `stripe listen`. |

---

## 16. Information still needed from the client

- Forwarding API **URL** and HTTP **method**
- Expected **JSON schema** for the forwarded payload
- **Authentication** method for that API
- Whether **forwarding is required** or optional
- Whether the **full customer e-mail** may be logged or forwarded

---

## 17. Final submission checklist

- [ ] `npm install` and `npm test` work on your machine (40 passing)
- [ ] Stripe CLI test done: `stripe listen` + `stripe trigger checkout.session.completed` → 200, line in `logs/webhook-events.jsonl`
- [ ] Postman collection imports; health = 200, fake/missing signature = 400
- [ ] `.env` is **not** in the repository (`git status` / GitHub page)
- [ ] No real keys anywhere (`git grep -nE "sk_(test|live)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}"` shows nothing)
- [ ] `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, README, Postman file, `docs/technical-summary.md` are all committed
- [ ] `docs/technical-summary.md` converted to PDF (see below) and your own Stripe CLI test result noted
- [ ] Repository link (private: add the client as collaborator, or follow SkillNexa instructions) and PDF submitted before **13 November 2026**

**Convert the technical summary to PDF** (pick one):
- Run `npm run pdf` (automatically generates `docs/technical-summary.pdf` using headless Edge)
- Open `docs/technical-summary.md` in VS Code with the "Markdown PDF" extension
- `pandoc docs/technical-summary.md -o docs/technical-summary.pdf`
