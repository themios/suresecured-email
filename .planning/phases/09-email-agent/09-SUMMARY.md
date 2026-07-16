---
phase: 09-email-agent
plan: SUMMARY
subsystem: agents
tags: [multi-tenant, email, approval-gate, deliverability-guards]
status: deployed
commit: 31ccf39
completed: 2026-07-16

requires:
  - phase: 07-agent-foundation (runner, proposals queue, events)
  - phase: 08-segmentation (segment targeting)
  - phase: 03-email-deliverability (sendDirectEmail, suppression, unsubscribe)
provides:
  - Email agent — drafts follow-ups to agent_proposals (pending); never auto-sends
  - Approval queue UI + approve/reject routes; sendApprovedDraft with send-time guards
  - email.drafted / email.sent events
affects: [reporting]

key-files:
  created:
    - src/lib/agents/email.js
  modified:
    - src/lib/agents/scheduler.js (dispatch + order)
    - src/lib/agents/agents.test.js
    - src/routes/settings.js (Email live + approval queue + POST approve/reject)

key-decisions:
  - "First agent that can send → strict human approval gate; agent only writes pending drafts."
  - "Suppression + unsubscribe re-checked at send time (defense in depth), reusing existing sendDirectEmail."
---

# Phase 09 — Email Agent (approval-gated): Summary

The first agent capable of a send, so it is the most carefully gated. The agent
ONLY drafts personalized follow-ups (LLM) into `agent_proposals` (status
pending), targeting engaged, contactable leads in configured segments, capped per
run, skipping unsubscribed/suppressed and leads that already have a pending draft.
An operator approves in Settings → AI Agents; `sendApprovedDraft` re-checks
suppression/unsubscribe, sends via the existing provider path, marks the proposal
applied, emits `email.sent`, and logs a lead note. Reject discards.

**Verified:** unit tests (draft prompt) + full local integration — nothing
auto-sends, no duplicate drafts, approve sends exactly once (injected sender),
suppression guard blocks a send (dismisses proposal), double-approve is a no-op.
