// Every table the platform stores, with a plain name and how it can be seen.
// Spec: specs/2026-10-14-data-visibility.md
//
// A table missing from this list is a "hidden table": nobody can see what lands in it.
// src/test/dataRegistry.test.js fails when the schema and this list disagree, and the
// Data health page shows any unregistered table in a banner.
//
// visibility:
//   screen    a page in the app shows its records (where: which page)
//   counts    shown on Data health as counts only (why: reason no detail page exists)
//   internal  plumbing with no business meaning (why: reason it needs no view)
//
// This list is also the boundary of the Data health page: it reads only these tables.
// No table name ever comes from a request.

const screen = (label, where) => ({ label, visibility: 'screen', where });
const counts = (label, why) => ({ label, visibility: 'counts', why });
const internal = (label, why) => ({ label, visibility: 'internal', why });

const REGISTRY = Object.freeze({
  // Contacts and outreach
  leads: screen('Leads (contacts)', 'Leads'),
  lead_notes: screen('Lead notes', 'Leads, lead detail'),
  call_logs: screen('Call logs', 'Leads, lead detail'),
  sms_messages: screen('Text messages', 'Leads, lead detail'),
  contact_enrollments: screen('Sequence enrollments', 'Leads and Sequences'),
  sequences: screen('Sequences', 'Sequences'),
  sequence_steps: screen('Sequence steps', 'Sequences'),
  email_sends: screen('Emails sent', 'Leads, Sequences, Deliverability'),
  suppression_list: screen('Do-not-contact list', 'Admin, Suppression'),
  clicks: screen('Link clicks', 'Overview and Analytics'),
  form_submissions: screen('Customer website forms', 'Overview and Analytics'),
  phone_calls: screen('Phone calls', 'Overview and Analytics'),
  platform_leads: screen('Website form submissions (saleswyze.com)', 'Admin, Data, Form submissions'),

  // Sales and money
  orders: screen('Orders', 'Overview and Analytics'),
  commissions: screen('Commissions', 'Overview and Analytics'),
  salespeople: screen('Salespeople', 'Admin'),
  salesperson_goals: screen('Salesperson goals', 'Admin'),
  landing_page_matrix: screen('Landing page assignments', 'Admin'),
  commission_events: counts('Commission history', 'Change history behind Commissions. A detail page is planned separately.'),

  // Accounts and settings
  organizations: screen('Organizations', 'Admin, Clients'),
  clients: screen('Client accounts', 'Admin, Clients'),
  users: screen('Logins', 'Admin'),
  client_subscriptions: screen('Billing subscriptions', 'Billing'),
  client_email_config: screen('Email settings', 'Settings'),
  client_auth_domains: screen('Allowed sign-in domains', 'Settings'),
  email_accounts: screen('Connected mailboxes', 'Settings'),
  email_sources: screen('Inbound lead mailboxes', 'Settings'),
  email_source_rules: screen('Inbound lead sender rules', 'Settings'),
  seed_accounts: screen('Deliverability test inboxes', 'Settings'),
  seed_checks: screen('Deliverability test results', 'Settings and Deliverability'),
  audit_log: counts('Audit log (logins, security events, data views)', 'Security record. A detail page is planned separately.'),
  admin_users: internal('Legacy admin logins', 'Created by the original setup. Logins now live in Logins (users).'),

  // AI helpers
  client_agent_settings: screen('AI helper settings', 'Settings'),
  agent_plans: screen('AI monthly plans', 'Settings'),
  agent_reports: screen('AI weekly reports', 'Overview'),
  agent_proposals: screen('AI drafts awaiting approval', 'Overview and Settings'),
  agent_runs: counts('AI helper runs', 'Run history and cost. A detail page is planned separately.'),
  agent_events: counts('AI helper events', 'Event history behind the AI helpers. A detail page is planned separately.'),
  digest_sends: counts('Daily digest sends', 'One row per digest sent, used to avoid sending twice.'),

  // Plumbing
  send_identities: counts('Sending mailboxes (warm-up)', 'Warm-up state per sending address, shown as counts.'),
  send_counters: internal('Daily send counters', 'Per-mailbox daily tallies that enforce sending limits.'),
  tracking_tokens: internal('Click tracking links', 'Link codes used to attribute a click. No business content.'),
  email_tracking_tokens: internal('Email open and click codes', 'Codes embedded in sent email. No business content.'),
  estimate_verifications: internal('Form confirmation codes', 'Hashed single-use confirmation codes for the website form.'),
  form_quota: internal('Spam limit counters', 'Counters behind the website form spam limits and alert de-duplication.'),
  schema_migrations: internal('Database version history', 'Which database upgrades have run.'),
});

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

module.exports = { REGISTRY, TABLE_NAME_RE };
