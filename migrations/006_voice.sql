-- 006_voice.sql
-- Voice phase: Telnyx SMS + Retell AI inbound call routing

-- Retell agent IDs and voice extension per client
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS retell_agent_id     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS retell_llm_id       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS voice_extension     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS telnyx_phone_number VARCHAR(50);

-- Inbound voice calls from Retell post-call webhook
CREATE TABLE IF NOT EXISTS call_logs (
  id                   SERIAL PRIMARY KEY,
  client_id            INTEGER REFERENCES clients(id),
  lead_id              INTEGER REFERENCES leads(id),
  retell_call_id       VARCHAR(255) UNIQUE NOT NULL,
  from_number          VARCHAR(50),
  to_number            VARCHAR(50),
  direction            VARCHAR(20) DEFAULT 'inbound',
  duration_seconds     INTEGER DEFAULT 0,
  transcript           TEXT,
  disconnection_reason VARCHAR(100),
  call_started_at      TIMESTAMPTZ,
  call_ended_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id    ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_retell_id  ON call_logs(retell_call_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_client_id  ON call_logs(client_id);

-- SMS messages (inbound replies and outbound sequence steps)
CREATE TABLE IF NOT EXISTS sms_messages (
  id                SERIAL PRIMARY KEY,
  enrollment_id     INTEGER REFERENCES contact_enrollments(id),
  step_id           INTEGER REFERENCES sequence_steps(id),
  lead_id           INTEGER REFERENCES leads(id),
  client_id         INTEGER REFERENCES clients(id),
  direction         VARCHAR(20) NOT NULL,
  from_number       VARCHAR(50),
  to_number         VARCHAR(50),
  body              TEXT,
  telnyx_message_id VARCHAR(255),
  status            VARCHAR(30) DEFAULT 'queued',
  sent_at           TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_lead_id    ON sms_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_enrollment ON sms_messages(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_client_id  ON sms_messages(client_id);

-- SMS dispatch channel on sequence steps (default 'email' preserves all existing steps)
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'email';

-- Phone number on leads (required for SMS dispatch and call-ended lead upsert)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

-- client_id and replied_at on contact_enrollments (may already exist from prior migrations — safe to re-add)
ALTER TABLE contact_enrollments
  ADD COLUMN IF NOT EXISTS client_id  INTEGER REFERENCES clients(id),
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
