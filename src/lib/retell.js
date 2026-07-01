// src/lib/retell.js
// Retell AI REST API wrapper — plain https.request (no SDK)
// Requires env: RETELL_API_KEY
const https = require('https');

function retellRequest(method, path, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.retellai.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Create a Retell LLM Response Engine with a system prompt.
 * Must be called before createAgent().
 * @param {string} generalPrompt - System prompt for the voice agent
 * @returns {{ ok: boolean, llmId?: string, error?: object }}
 */
async function createLlm(generalPrompt) {
  const r = await retellRequest('POST', '/create-retell-llm', {
    general_prompt: generalPrompt,
    begin_message: 'Hi, thanks for calling. How can I help you today?',
  });
  if (r.status === 201) return { ok: true, llmId: r.body.llm_id };
  return { ok: false, error: r.body };
}

/**
 * Create a Retell voice agent bound to an LLM.
 * @param {string} llmId      - From createLlm()
 * @param {string} agentName  - Display name e.g. "Acme AI Agent"
 * @param {string} webhookUrl - Full URL for call_ended events e.g. "https://app.railway.app/retell-hooks/call-ended"
 * @returns {{ ok: boolean, agentId?: string, error?: object }}
 */
async function createAgent(llmId, agentName, webhookUrl) {
  const r = await retellRequest('POST', '/create-agent', {
    response_engine: { type: 'retell-llm', llm_id: llmId },
    agent_name: agentName,
    voice_id: '11labs-Adrian',
    webhook_url: webhookUrl,
  });
  if (r.status === 201) return { ok: true, agentId: r.body.agent_id };
  return { ok: false, error: r.body };
}

module.exports = { createLlm, createAgent };
