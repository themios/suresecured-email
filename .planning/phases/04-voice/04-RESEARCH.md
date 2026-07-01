# Phase 4: Voice - Research

**Researched:** 2026-06-30
**Domain:** Telnyx (voice + SMS carrier) + Retell AI (voice agent) + sequence dispatch hook
**Confidence:** HIGH (all critical facts verified via Context7 official docs + Retell official docs)

---

## Summary

Phase 4 connects the existing Telnyx number (+18183810202) to Retell AI for inbound voice calls, adds post-call lead creation, and extends the sequence step dispatcher to send SMS via Telnyx in addition to email.

The Telnyx-to-Retell path uses **elastic SIP trunking**: Telnyx routes inbound calls to Retell's SIP server (`sip.retellai.com`) over TCP. The number is imported into Retell via API with a `termination_uri` pointing back to Telnyx's FQDN. Retell's inbound webhook then gives the app the chance to pick the right agent per client before the call begins. Post-call data (transcript, caller number, duration) arrives via Retell's `call_ended` webhook.

SMS is entirely within Telnyx: `POST /messages` for outbound, `message.received` webhook event for inbound. The existing cron dispatcher loop can dispatch SMS steps with a single `if (step.channel === 'sms')` branch.

**Primary recommendation:** Use Telnyx elastic SIP trunking + Retell custom telephony import. Do not use Retell's native Telnyx number purchasing — you already own +18183810202.

---

## Standard Stack

### Core
| Component | Version/Endpoint | Purpose | Why Standard |
|-----------|-----------------|---------|--------------|
| Telnyx elastic SIP trunk | Telnyx portal config | Routes inbound calls from Telnyx number to Retell SIP server | Only path for BYOT with Retell |
| Retell `POST /v2/register-phone-call` | `api.retellai.com` | Registers each call, returns `call_id` for SIP dial | Required for custom telephony |
| Retell `POST /create-retell-llm` | `api.retellai.com` | Creates the LLM Response Engine with prompt | Must create LLM before agent |
| Retell `POST /create-agent` | `api.retellai.com` | Creates voice agent bound to LLM | Returns `agent_id` stored per client |
| Retell `POST /import-phone-number` | `api.retellai.com` | Imports +18183810202 into Retell | Sets termination_uri + inbound_webhook_url |
| Telnyx `POST /messages` | `api.telnyx.com/v2/messages` | Outbound SMS | Single endpoint, no SDK needed |
| Telnyx `message.received` webhook | inbound webhook event | Inbound SMS handling | Same webhook infra as existing |

### Supporting
| Component | Purpose | When to Use |
|-----------|---------|-------------|
| Retell inbound webhook (`inbound_webhook_url`) | App receives call before it connects; responds with `call_inbound.override_agent_id` | Always — required to pick right client's agent |
| Retell `call_ended` event webhook | Post-call data: transcript, caller, duration | Register at account level or per-agent |
| Telnyx A2P 10DLC | Mandatory for US SMS as of Feb 2025 | Required before any SMS goes out |

### No SDK Needed
All Telnyx and Retell calls can be made with plain `https.request` (Node core). Follow the pattern from `src/lib/gmail.js` — write a `src/lib/telnyx.js` and `src/lib/retell.js` each exporting thin wrapper functions.

---

## Architecture Patterns

### Recommended File Structure
```
src/
├── lib/
│   ├── telnyx.js          # sendSms(to, from, text), parseSmsWebhook(body)
│   └── retell.js          # createLlm(prompt), createAgent(llmId, name), registerCall(agentId, from, to), parseCallEndedWebhook(body)
├── routes/
│   ├── telnyx-webhook.js  # POST /webhooks/telnyx  (SMS inbound, call status)
│   └── retell-webhook.js  # POST /webhooks/retell  (call_ended, call_analyzed)
migrations/
└── 004_voice.sql          # new tables + columns
```

### Pattern 1: Telnyx SIP Trunk → Retell (Inbound Call Flow)

**What:** Telnyx elastic SIP trunk sends all calls destined for +18183810202 to `sip.retellai.com;transport=tcp`. Before the call connects, Retell calls your `inbound_webhook_url`. Your app looks up which client owns the "To" number, picks that client's `retell_agent_id`, and returns it in the response.

**Step-by-step:**
1. In Telnyx portal: Create elastic SIP trunk, FQDN = `sip.retellai.com`, DNS record type = SRV, transport = TCP. Set credential-based auth (username + password).
2. Assign number +18183810202 to that SIP trunk.
3. Call Retell `POST /import-phone-number`:
```json
{
  "phone_number": "+18183810202",
  "termination_uri": "sip.telnyx.com",
  "sip_trunk_auth_username": "YOUR_TELNYX_CREDENTIAL_USERNAME",
  "sip_trunk_auth_password": "YOUR_TELNYX_CREDENTIAL_PASSWORD",
  "inbound_webhook_url": "https://YOUR_RAILWAY_APP/webhooks/retell/inbound"
}
```
4. Retell calls `POST /webhooks/retell/inbound` for each inbound call. Request body:
```json
{ "event": "call_inbound", "call": { "to_number": "+18183810202", "from_number": "+1...", "call_id": "..." } }
```
5. App responds:
```json
{ "call_inbound": { "override_agent_id": "agent_XYZ" } }
```
6. Call connects to that agent.

**Source:** https://docs.retellai.com/deploy/telnyx and https://docs.retellai.com/features/inbound-call-webhook (HIGH confidence)

### Pattern 2: Retell Agent Provisioning per Client

**What:** Each client gets their own LLM + agent created via API. The `agent_id` is stored in the `clients` table.

**Step 1 — Create LLM:**
```
POST https://api.retellai.com/create-retell-llm
Authorization: Bearer RETELL_API_KEY
Content-Type: application/json

{
  "general_prompt": "You are a sales assistant for {client_name}...",
  "begin_message": "Hi, thanks for calling {client_name}. How can I help you today?"
}
```
Returns `{ "llm_id": "llm_xxx" }`.

**Step 2 — Create Agent:**
```
POST https://api.retellai.com/create-agent
Authorization: Bearer RETELL_API_KEY

{
  "response_engine": { "type": "retell-llm", "llm_id": "llm_xxx" },
  "agent_name": "ClientName AI Agent",
  "voice_id": "11labs-Adrian",
  "webhook_url": "https://YOUR_APP/webhooks/retell/events"
}
```
Returns `{ "agent_id": "agent_xxx" }`.

Store `agent_id` and `llm_id` in `clients` table.

**Source:** https://docs.retellai.com/api-references/create-agent (HIGH confidence)

### Pattern 3: Post-Call Webhook → Lead Record

**What:** Retell POSTs to your `webhook_url` after call ends.

Retell `call_ended` payload (confirmed fields):
```json
{
  "event": "call_ended",
  "call": {
    "call_type": "phone_call",
    "from_number": "+12137771234",
    "to_number": "+18183810202",
    "direction": "inbound",
    "call_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
    "agent_id": "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
    "call_status": "ended",
    "start_timestamp": 1714608475945,
    "end_timestamp": 1714608491736,
    "disconnection_reason": "user_hangup",
    "transcript": "Agent: Hi...\nUser: Hello...",
    "transcript_object": [...],
    "metadata": {}
  }
}
```
App should: look up/create lead by `from_number`, insert `call_logs` row, auto-enroll in a sequence.

**Source:** https://docs.retellai.com/features/webhook (HIGH confidence)

### Pattern 4: Telnyx Inbound SMS Webhook

Telnyx POSTs to your webhook URL (set on the messaging profile) on `message.received` event:
```json
{
  "data": {
    "event_type": "message.received",
    "payload": {
      "direction": "inbound",
      "from": { "phone_number": "+13125550001" },
      "to": [{ "phone_number": "+18183810202" }],
      "text": "Hello from Telnyx!",
      "type": "SMS"
    }
  }
}
```
**Extract:** `data.payload.from.phone_number`, `data.payload.text`.
Action: store reply in `sms_messages`, pause enrollment, notify salesperson.

**Source:** https://developers.telnyx.com/docs/messaging/messages/receive-message (HIGH confidence)

### Pattern 5: Outbound SMS via Telnyx

```
POST https://api.telnyx.com/v2/messages
Authorization: Bearer TELNYX_API_KEY
Content-Type: application/json

{
  "from": "+18183810202",
  "to": "+1XXXXXXXXXX",
  "text": "Hi John, just following up..."
}
```
Returns `{ "data": { "id": "msg_xxx", "status": "queued" } }`.

No SDK needed — plain `https.request` or `node-fetch` equivalent suffices.

**Source:** https://developers.telnyx.com/api-reference/messages/send-a-message (HIGH confidence)

### Pattern 6: SMS Step in Sequence Dispatcher (cron.js hook)

The current cron loop in `src/routes/cron.js` always calls `sendSequenceEmail()`. The hook point is after `const step = steps[0]`:

```javascript
// In cron.js send-sequences loop, after fetching step:
if (step.channel === 'sms') {
  // send SMS path
  const leadPhone = row.lead_phone; // requires phone in leads query
  if (!leadPhone) { skipped++; continue; }
  const smsResult = await sendSequenceSms({ to: leadPhone, body: step.body, vars, enrollmentId: row.enrollment_id, stepId: step.id, leadId: row.lead_id });
  // handle smsResult.ok / smsResult.error same as email
} else {
  // existing email path (unchanged)
  const sendResult = await sendSequenceEmail(...);
}
```

`sequence_steps` needs a `channel` column (`'email'` default, `'sms'` opt-in per step). `leads` needs `phone` in the SELECT.

### Anti-Patterns to Avoid
- **Registering a fresh Telnyx number inside Retell:** You already own +18183810202 — use import, not purchase.
- **Using TeXML for the inbound call flow:** Retell's custom telephony path uses SIP, not TeXML. TeXML webhooks fire for status/answering callbacks but the actual media routing is SIP.
- **Polling Retell for call results:** Use the webhook; don't poll GET /get-call.
- **Per-step SMS without a paused-on-reply check:** The existing email path checks for thread replies before sending the next step. The SMS path must check `sms_messages` for inbound reply before sending the next SMS step (same logic, different table).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SIP media bridging | Any custom WebRTC/SIP code | Retell SIP endpoint (`sip.retellai.com`) | Retell handles all audio, AI, transcript |
| Phone number routing logic in Telnyx | TeXML dial logic | Retell inbound webhook response | Retell does the routing after your agent override |
| Voice AI / ASR / TTS | Any local speech pipeline | Retell agent + LLM | Out of scope and complex |
| SMS status tracking | Custom delivery polling | Telnyx `message.delivered` webhook event | Telnyx fires status updates automatically |
| 10DLC registration | Manual carrier submissions | Telnyx portal Brand + Campaign registration | Telnyx handles TCR submission |

---

## Common Pitfalls

### Pitfall 1: Missing inbound_webhook_url on import
**What goes wrong:** All inbound calls go to a default agent (or fail) instead of the client-specific agent.
**Why it happens:** `inbound_webhook_url` is optional in the import API — easy to omit.
**How to avoid:** Always set `inbound_webhook_url` when calling `POST /import-phone-number`. Verify by making a test call and checking logs.

### Pitfall 2: Telnyx SIP trunk uses UDP instead of TCP
**What goes wrong:** Audio quality issues or dropped connections.
**Why it happens:** UDP is the default in some Telnyx trunk configs. Retell recommends TCP.
**How to avoid:** Explicitly set transport = TCP when creating the SIP trunk FQDN entry.

### Pitfall 3: Retell webhook body not parsed (content-type mismatch)
**What goes wrong:** `req.body` is empty or unparsed on the Retell webhook route.
**Why it happens:** `src/index.js` mounts `/webhooks` BEFORE `express.json()` to preserve raw body for HMAC. Retell POSTs JSON, not raw.
**How to avoid:** Mount the Retell webhook route AFTER `express.json()` middleware, or apply `express.json()` directly to that specific route. The existing raw-body pattern at `/webhooks` is for Shopify HMAC — don't reuse that mount point for Retell.
**Specific fix:** Register `/webhooks/retell` after `app.use(express.json())` in `index.js`, or create a separate mount like `/retell-hooks` that gets JSON parsing.

### Pitfall 4: 10DLC not registered before sending SMS
**What goes wrong:** Telnyx blocks all outbound SMS silently or with error code.
**Why it happens:** As of Feb 2025, US carriers block all unregistered A2P traffic. Registration is mandatory.
**How to avoid:** Register Brand + Campaign in Telnyx portal BEFORE writing any SMS send code. Approval takes 3-7 business days. Plan ahead.

### Pitfall 5: Retell `call_ended` fires before `call_analyzed`
**What goes wrong:** Transcript may be incomplete/missing in `call_ended`; full analysis arrives later in `call_analyzed`.
**Why it happens:** Retell processes analysis asynchronously after call ends.
**How to avoid:** Handle both events. Create the lead record on `call_ended` (using `transcript` field which is present). Optionally update with richer data on `call_analyzed` if you add post-call analysis fields.

### Pitfall 6: No phone number on lead — SMS step silently skipped
**What goes wrong:** SMS steps dispatch nothing because `lead_phone` is null.
**Why it happens:** Many leads are ingested with email only.
**How to avoid:** Add explicit null check and log/skip with reason `'no_phone'`. Mirror the existing `suppressed` skip pattern.

### Pitfall 7: Double-processing enrollment on inbound call
**What goes wrong:** Caller gets enrolled twice if they call back before the first enrollment completes.
**Why it happens:** `contact_enrollments` has `UNIQUE(lead_id, sequence_id)` but `POST /call-ended` doesn't check existing enrollment.
**How to avoid:** Use `INSERT ... ON CONFLICT DO NOTHING` when auto-enrolling from a post-call webhook.

---

## Code Examples

### telnyx.js — send outbound SMS (no SDK)
```javascript
// src/lib/telnyx.js
const https = require('https');

function telnyxRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telnyx.com',
      path: `/v2${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
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

async function sendSms(to, from, text) {
  const result = await telnyxRequest('POST', '/messages', { to, from, text });
  if (result.status === 200) {
    return { ok: true, messageId: result.body.data.id };
  }
  return { ok: false, error: JSON.stringify(result.body.errors || result.body) };
}

module.exports = { sendSms };
```
Source: https://developers.telnyx.com/api-reference/messages/send-a-message (HIGH confidence)

### retell.js — register call + parse webhooks (no SDK)
```javascript
// src/lib/retell.js
const https = require('https');

function retellRequest(method, path, body) {
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
    if (payload !== '{}') req.write(payload);
    req.end();
  });
}

async function createLlm(generalPrompt) {
  const r = await retellRequest('POST', '/create-retell-llm', { general_prompt: generalPrompt });
  if (r.status === 201) return { ok: true, llmId: r.body.llm_id };
  return { ok: false, error: r.body };
}

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
```
Source: https://docs.retellai.com/api-references/create-agent (HIGH confidence)

### Retell inbound webhook handler
```javascript
// src/routes/retell-webhook.js (mounted AFTER express.json())
router.post('/inbound', async (req, res) => {
  const { call } = req.body;
  const toNumber = call?.to_number;
  
  // Look up which client owns this number
  const { rows } = await pool.query(
    'SELECT retell_agent_id FROM clients WHERE telnyx_phone_number = $1 AND active = true LIMIT 1',
    [toNumber]
  );
  
  if (!rows[0]?.retell_agent_id) {
    // Fall back to default agent or reject
    return res.status(200).json({ call_inbound: {} });
  }
  
  return res.status(200).json({
    call_inbound: { override_agent_id: rows[0].retell_agent_id }
  });
});
```
Source: https://docs.retellai.com/features/inbound-call-webhook (HIGH confidence)

### Migration 004 — voice tables
```sql
-- 004_voice.sql

-- Retell agent IDs per client
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS retell_agent_id    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS retell_llm_id      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS telnyx_phone_number VARCHAR(50);

-- Track inbound voice calls from Retell post-call webhook
CREATE TABLE IF NOT EXISTS call_logs (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  lead_id         INTEGER REFERENCES leads(id),
  retell_call_id  VARCHAR(255) UNIQUE NOT NULL,
  from_number     VARCHAR(50),
  to_number       VARCHAR(50),
  direction       VARCHAR(20) DEFAULT 'inbound',
  duration_seconds INTEGER DEFAULT 0,
  transcript      TEXT,
  disconnection_reason VARCHAR(100),
  call_started_at  TIMESTAMPTZ,
  call_ended_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_retell_id ON call_logs(retell_call_id);

-- SMS messages (both inbound replies and outbound sequence steps)
CREATE TABLE IF NOT EXISTS sms_messages (
  id              SERIAL PRIMARY KEY,
  enrollment_id   INTEGER REFERENCES contact_enrollments(id),
  step_id         INTEGER REFERENCES sequence_steps(id),
  lead_id         INTEGER REFERENCES leads(id),
  client_id       INTEGER REFERENCES clients(id),
  direction       VARCHAR(20) NOT NULL,  -- 'outbound' | 'inbound'
  from_number     VARCHAR(50),
  to_number       VARCHAR(50),
  body            TEXT,
  telnyx_message_id VARCHAR(255),
  status          VARCHAR(30) DEFAULT 'queued',
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_lead_id ON sms_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_enrollment ON sms_messages(enrollment_id);

-- Add channel to sequence_steps ('email' default, 'sms' for SMS steps)
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'email';

-- Add phone to leads (needed for SMS dispatch)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- Add client_id to contact_enrollments (already may exist but ensure)
ALTER TABLE contact_enrollments
  ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);

-- Add replied_at to contact_enrollments (already in schema as nullable)
ALTER TABLE contact_enrollments
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Twilio-only integrations for Retell | Retell has native Telnyx import path | Telnyx works directly — no Twilio needed |
| Unregistered 10DLC SMS | Mandatory 10DLC as of Feb 2025 | Must register before any SMS goes out |
| TeXML to bridge calls | Elastic SIP trunk + Retell SIP endpoint | No TeXML needed for media routing |

---

## Open Questions

1. **Telnyx Messaging Profile ID**
   - What we know: Outbound SMS via `POST /messages` can use `from` number directly without specifying `messaging_profile_id` if the number has a default profile.
   - What's unclear: Whether +18183810202 already has a messaging profile configured on the Telnyx account.
   - Recommendation: Check Telnyx portal. If no profile exists, create one and link the number before SMS code runs.

2. **10DLC Registration Status**
   - What we know: All US A2P SMS requires 10DLC as of Feb 2025.
   - What's unclear: Whether the Telnyx account has a brand/campaign already registered.
   - Recommendation: Verify in Telnyx portal under "Messaging > Brands & Campaigns" before planning SMS timeline. If not registered, block 3-7 days for approval in the schedule.

3. **Retell voice_id selection**
   - What we know: `voice_id` is required at agent creation; `"11labs-Adrian"` is a documented example.
   - What's unclear: Which voice is preferred for this use case.
   - Recommendation: Default to `"11labs-Adrian"` (ElevenLabs, English male). Make it a `brand_config` field if clients want different voices later.

4. **Single Telnyx number for multi-client**
   - What we know: The scope says "a single Telnyx number routes to the correct client's Retell AI agent."
   - What's unclear: How the inbound webhook will distinguish clients when there's only one number — presumably by `to_number` matching the one number, and the routing is done by other context (e.g., the only active client, or via metadata passed during call registration).
   - Recommendation: For MVP, look up the single active client for the known number. Make the lookup flexible so adding a second number per client later is straightforward.

---

## Sources

### Primary (HIGH confidence)
- `/websites/retellai` via Context7 — inbound call webhook, import-phone-number API, call_ended webhook, create-agent API, create-retell-llm API
- `/websites/developers_telnyx` via Context7 — call.answered webhook, message.received webhook payload, POST /messages send, 10DLC registration requirement
- https://docs.retellai.com/deploy/telnyx — Telnyx-specific SIP trunk setup steps (WebFetch)
- https://docs.retellai.com/features/inbound-call-webhook — inbound override response format
- https://docs.retellai.com/features/webhook — call_ended payload structure

### Secondary (MEDIUM confidence)
- WebSearch: Telnyx SIP FQDN = `sip.telnyx.com`, termination URI for Retell import — confirmed in Retell deploy/telnyx page
- WebSearch: 10DLC now mandatory, 3-7 day approval timeline — consistent with Telnyx support articles

---

## Metadata

**Confidence breakdown:**
- Telnyx SMS (inbound + outbound): HIGH — verified via official Context7 docs
- Retell agent/LLM creation: HIGH — verified via official Context7 docs
- Telnyx SIP trunk → Retell connection: HIGH — verified via official Retell deploy/telnyx page
- Inbound call webhook format + response: HIGH — verified via official Retell docs
- Post-call webhook payload: HIGH — exact JSON from official Retell webhook docs
- cron.js SMS hook point: HIGH — read actual source file
- 10DLC requirement: HIGH — Telnyx states it's mandatory as of Feb 2025
- Specific Telnyx FQDN value (`sip.telnyx.com`): MEDIUM — from WebSearch confirmed by Retell deploy page

**Research date:** 2026-06-30
**Valid until:** 2026-09-30 (Retell API is active but evolves; re-verify if > 90 days)
