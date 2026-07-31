require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const { initDb } = require('./db');

const { requireAuth, requireRole } = require('./middleware/auth');
const { loginLimiter, apiLimiter, cronLimiter } = require('./middleware/rateLimit');

const redirectRouter = require('./routes/redirect');
const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');
const dashboardRouter = require('./routes/dashboard');
const phonecallRouter = require('./routes/phonecall');
const { router: analyticsRouter } = require('./routes/analytics');
const adminRouter     = require('./routes/admin');
const portalRouter    = require('./routes/portal');
const sequencesRouter = require('./routes/sequences');
const leadsRouter     = require('./routes/leads');
const activityRouter  = require('./routes/activity');
const gmailOAuthRouter = require('./routes/gmail-oauth');
const cronRouter        = require('./routes/cron');
const unsubscribeRouter = require('./routes/unsubscribe');
const settingsRouter    = require('./routes/settings');
const billingRouter     = require('./routes/billing');
const retellRouter      = require('./routes/retell');
const telnyxRouter      = require('./routes/telnyx');
const twilioRouter      = require('./routes/twilio');
const pixelRouter       = require('./routes/pixel');
const emailClickRouter  = require('./routes/email-click');
const marketingRouter   = require('./routes/marketing');
const { router: deliverabilityRouter } = require('./routes/deliverability');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // inline Tailwind/HTML dashboards
  crossOriginEmbedderPolicy: false,
}));

// Webhooks need raw body for HMAC verification — must come before json middleware
app.use('/webhooks', webhookRouter);

// Capture the raw request bytes on every JSON body so webhook handlers
// (Retell HMAC, Telnyx Ed25519) can verify signatures against the exact payload.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// Browsers request this by default on every page load; no static asset is
// served here, so it 404'd (harmless, but noisy in devtools) on every page.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Rate limits
app.use('/login', loginLimiter);
// The password-check route is POST /auth/login (auth.js), not /login — that
// GET page. Express path-prefix matching on '/login' never reaches it, so the
// actual brute-force target had NO rate limit until this line.
app.use('/auth/login', loginLimiter);
app.use('/portal/login', loginLimiter);
app.use('/api', apiLimiter);
app.use('/cron', cronLimiter);

// Tracking redirects
app.use('/r', redirectRouter);

// Pixel tracking (no auth — must be publicly accessible)
app.use('/pixel', pixelRouter);

// Email click tracking (no auth — tracked email link redirect)
app.use('/e', emailClickRouter);

// Public marketing site — owns GET / and POST /get-started
app.use('/', marketingRouter);

// Auth
app.use('/', authRouter);

// Dashboard
app.use('/dashboard', dashboardRouter);

// API
app.use('/api', apiRouter);

// CallRail phone call webhook
app.use('/api/phone-call', phonecallRouter);

// Analytics
app.use('/analytics', analyticsRouter);

// Admin
app.use('/admin', adminRouter);

// Salesperson portal
app.use('/portal', portalRouter);

// CRM leads
app.use('/leads', leadsRouter);

// Dashboard KPI drill-down pages (orders, commissions, calls, clicks, form submissions)
app.use('/', activityRouter);

// Email sequences
app.use('/sequences', sequencesRouter);

// Gmail OAuth connect/callback
app.use('/gmail', gmailOAuthRouter);

// Cron — send due emails
app.use('/cron', cronRouter);

// Retell AI webhook handlers — must be after express.json()
app.use('/retell-hooks', retellRouter);

// Telnyx SMS webhook handlers — must be after express.json()
app.use('/telnyx-hooks', telnyxRouter);
app.use('/twilio-hooks', twilioRouter);

// Unsubscribe (no auth — must be publicly accessible)
app.use('/unsubscribe', unsubscribeRouter);

// Tenant settings
app.use('/settings', settingsRouter);
app.use('/billing', billingRouter);

// Delivery feedback: /api/sending-health (banner) + /undelivered (list).
// Mounted at root because it owns both an /api path and a top-level page.
// Must come before the /api rate limiter's catch-all handlers do anything
// surprising — it is a cheap authenticated read polled once per page load.
app.use('/', deliverabilityRouter);

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global error handler. Express 5 forwards rejected async handlers here, so an
// unhandled error in any route lands as a clean 500 instead of a hung request.
// Log the full error server-side; never leak internals to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message || err);
  if (res.headersSent) return next(err);
  const wantsJson = (req.headers.accept || '').includes('application/json') || req.originalUrl.startsWith('/api');
  res.status(err.status || 500);
  if (wantsJson) return res.json({ error: 'Something went wrong.' });
  res.type('text/plain').send('Something went wrong.');
});

// Last-resort process guards. An unhandled rejection is logged but survivable;
// an uncaught exception leaves the process in an undefined state, so log and let
// the platform restart us (Railway auto-restarts on non-zero exit).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && (reason.stack || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err));
  process.exit(1);
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Sales Tracker running on port ${PORT}`);
  });

  // THIS IS THE ONLY SCHEDULER. The [[cron]] blocks in railway.toml look like
  // they schedule these jobs, but that is not a real Railway config key (cron is
  // a per-service `cronSchedule`, and a cron service runs its start command
  // instead of serving HTTP). Those blocks are inert — do not delete this
  // node-cron block on the assumption railway.toml covers it.
  //
  // Each job is a POST to its own /cron/<name> endpoint (Bearer CRON_SECRET),
  // so the schedule and the work stay decoupled. All five jobs are idempotent
  // or no-ops until a tenant opts in (poll-email-sources / run-agents), so
  // enabling them is safe. IMPORTANT: keep this service at ONE replica — there
  // is no cross-instance lock yet, so a second replica would double-send.
  const fireCron = async (name) => {
    try {
      const res = await fetch(`http://localhost:${PORT}/cron/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const data = await res.json().catch(() => ({}));
      console.log(`[cron] ${name}:`, JSON.stringify(data));
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err.message);
    }
  };

  // Send due sequence emails — every 15 minutes (unchanged).
  cron.schedule('*/15 * * * *', () => fireCron('send-sequences'));
  // Ingest new leads from connected email intake sources — every 15 minutes.
  cron.schedule('*/15 * * * *', () => fireCron('poll-email-sources'));
  // Run any AI marketing agents that are due — every 30 minutes (no-op until enabled).
  cron.schedule('*/30 * * * *', () => fireCron('run-agents'));
  // Recompute lead engagement scores — every 6 hours.
  cron.schedule('0 */6 * * *', () => fireCron('score-leads'));
  // Daily metrics digest to each operator — 06:00 UTC.
  cron.schedule('0 6 * * *', () => fireCron('daily-digest'));
  // Seed canary: check where the last campaign send landed (inbox/spam/promo)
  // for every tenant with a connected seed inbox — no-op until one is connected.
  // Runs after send-sequences has had all day to generate real mail to check.
  cron.schedule('0 8 * * *', () => fireCron('seed-check'));
}

// Only boot the server + scheduler when run directly. Tests require this module
// to get the configured `app` and mount it themselves, without listening or
// scheduling crons.
if (require.main === module) {
  start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
