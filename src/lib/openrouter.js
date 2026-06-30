/**
 * OpenRouter API client — native https, no SDK, zero dependencies
 * Model: google/gemini-2.5-flash
 */
const https = require('https');

function callOpenRouter(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'HTTP-Referer': process.env.TRACKER_URL || 'https://salespilot.app',
        'X-Title': 'SalesPilot Digest',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error('OpenRouter error: ' + JSON.stringify(parsed.error)));
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(new Error('OpenRouter parse error: ' + data.slice(0, 200)));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('OpenRouter timeout after 30s'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildDigestPrompt(metrics) {
  return `You are a sales analytics assistant. Summarize the following 24-hour email campaign metrics for an operator.
Write 3-4 plain English sentences. Be direct and actionable. No bullet lists. No markdown.

Metrics:
- New leads added: ${metrics.new_leads_24h}
- Emails sent: ${metrics.emails_sent_24h}
- Replies received: ${metrics.replies_24h}
- Reply rate: ${metrics.reply_rate_pct}%
- Bounces: ${metrics.bounces_24h}
- Average opens per email: ${parseFloat(metrics.avg_opens).toFixed(2)}
- Average clicks per email: ${parseFloat(metrics.avg_clicks).toFixed(2)}
- Top subject lines this week: ${metrics.top_subjects.join(' | ')}

Write the summary now:`;
}

module.exports = { callOpenRouter, buildDigestPrompt };
