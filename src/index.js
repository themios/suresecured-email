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
const retellRouter      = require('./routes/retell');
const telnyxRouter      = require('./routes/telnyx');
const pixelRouter       = require('./routes/pixel');
const emailClickRouter  = require('./routes/email-click');
const marketingRouter   = require('./routes/marketing');
const deliverabilityRouter = require('./routes/deliverability');

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

// Rate limits
app.use('/login', loginLimiter);
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

// Unsubscribe (no auth — must be publicly accessible)
app.use('/unsubscribe', unsubscribeRouter);

// Tenant settings
app.use('/settings', settingsRouter);

// Delivery feedback: /api/sending-health (banner) + /undelivered (list).
// Mounted at root because it owns both an /api path and a top-level page.
// Must come before the /api rate limiter's catch-all handlers do anything
// surprising — it is a cheap authenticated read polled once per page load.
app.use('/', deliverabilityRouter);

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Sales Tracker running on port ${PORT}`);
  });

  // THIS IS THE ONLY SCHEDULER. The [[cron]] blocks in railway.toml look like
  // they schedule these jobs, but that is not a real Railway config key (cron is
  // a per-service `cronSchedule`, and a cron service runs its start command
  // instead of serving HTTP). Those blocks are inert — do not delete this
  // node-cron block on the assumption railway.toml covers it. Verified against
  // production logs: '[cron] send-sequences' fires once per 15-min window, and
  // the four other jobs railway.toml claims to schedule never run at all.
  //
  // Known gaps, tracked separately: no locking (two instances would double-send,
  // so keep this service at one replica), and daily-digest / score-leads /
  // run-agents / poll-email-sources have no working schedule.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/cron/send-sequences`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const data = await res.json();
      console.log('[cron] send-sequences:', JSON.stringify(data));
    } catch (err) {
      console.error('[cron] send-sequences failed:', err.message);
    }
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
