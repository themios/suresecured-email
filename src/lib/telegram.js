const https = require('https');

function telegramEnabled() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function sendTelegram(text) {
  if (!telegramEnabled()) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id:    process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// Like sendTelegram but reports failure: rejects when Telegram is not configured, the
// network fails, or the API answers non-2xx. Use for alerts that are a control, where
// "sent" must mean delivered.
function sendTelegramStrict(text) {
  if (!telegramEnabled()) return Promise.reject(new Error('telegram not configured'));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`telegram http ${res.statusCode}`))));
    });
    req.setTimeout(10000, () => req.destroy(new Error('telegram timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function notifyNewLead({ firstName, lastName, email, source = 'inbound' }) {
  const name = [firstName, lastName].filter(Boolean).join(' ') || email;
  return sendTelegram(
    `🆕 <b>New Lead</b>\n` +
    `👤 ${name}\n` +
    `📧 ${email}\n` +
    `📥 Source: ${source}`
  );
}

function notifyHotReply({ firstName, lastName, email, category, urgency, summary, leadId, appUrl }) {
  const name = [firstName, lastName].filter(Boolean).join(' ') || email;
  const emoji = urgency === 'high' ? '🔥' : '💬';
  const url   = appUrl ? `\n🔗 <a href="${appUrl}/leads/${leadId}">View Lead</a>` : '';
  return sendTelegram(
    `${emoji} <b>Reply Received</b>\n` +
    `👤 ${name} (${email})\n` +
    `📌 ${(category || '').replace(/_/g, ' ')} · ${urgency || 'medium'} urgency\n` +
    (summary ? `💡 ${summary}` : '') +
    url
  );
}

function notifyDailySummary({ newLeads, replies, hotLeads, emailsSent, appUrl }) {
  const url = appUrl ? `\n🔗 <a href="${appUrl}">Open Dashboard</a>` : '';
  return sendTelegram(
    `📊 <b>Daily Summary</b>\n` +
    `👥 New leads: ${newLeads}\n` +
    `✉️ Emails sent: ${emailsSent}\n` +
    `💬 Replies: ${replies}\n` +
    `🔥 Hot leads: ${hotLeads}` +
    url
  );
}

module.exports = { telegramEnabled, sendTelegram, sendTelegramStrict, notifyNewLead, notifyHotReply, notifyDailySummary };
