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

/**
 * Classify an inbound reply into a sales intent category.
 * Returns one of: hot_lead | interested | needs_quote | question |
 *                 not_interested | already_purchased | unsubscribe | wrong_person | spam
 * Also returns a one-line summary and urgency (high | medium | low).
 */
async function classifyReply(replyText, leadName) {
  const prompt = `You are a sales assistant classifying an inbound email reply from a potential customer.

Lead name: ${leadName || 'Unknown'}
Their reply:
"""
${replyText.slice(0, 800)}
"""

Classify this reply. Respond with valid JSON only — no explanation, no markdown fences.

{
  "category": one of [hot_lead, interested, needs_quote, question, not_interested, already_purchased, unsubscribe, wrong_person, spam],
  "urgency": one of [high, medium, low],
  "summary": "one sentence describing what they said and what action the salesperson should take"
}`;

  try {
    const raw = await callOpenRouter(prompt);
    // Strip any markdown fences if model adds them
    const clean = raw.replace(/```[a-z]*\n?/gi, '').trim();
    return JSON.parse(clean);
  } catch {
    return { category: 'question', urgency: 'medium', summary: 'Reply received — review manually.' };
  }
}

module.exports = { callOpenRouter, buildDigestPrompt, classifyReply };
