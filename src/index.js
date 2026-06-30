require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { initDb } = require('./db');

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
const gmailOAuthRouter = require('./routes/gmail-oauth');
const cronRouter      = require('./routes/cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Webhooks need raw body for HMAC verification — must come before json middleware
app.use('/webhooks', webhookRouter);

app.use(express.json());
app.use(cookieParser());

// Tracking redirects
app.use('/r', redirectRouter);

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

// Email sequences
app.use('/sequences', sequencesRouter);

// Gmail OAuth connect/callback
app.use('/gmail', gmailOAuthRouter);

// Cron — send due emails
app.use('/cron', cronRouter);

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Root redirect
app.get('/', (req, res) => res.redirect('/dashboard'));

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Commission Tracker running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
