# Product Requirements Document (PRD)

# Project Name

SalesPilot AI
Version 1.3

Purpose:
Build an AI-powered outbound email automation, lead attribution, and commission tracking platform for SureSecured — a manufacturer and installer of marine-grade stainless steel security screen doors and windows based in Simi Valley, CA. The system will automate personalized email campaigns for both B2C homeowner leads and B2B contractor/dealer leads, intelligently respond to customer engagement, and permanently attribute leads to the originating salesperson for commission purposes.

---

# Company Overview — SureSecured

Website: https://suresecured.com
Phone: (747) 688-9992
Location: 1555 Simi Town Center Way #635, Simi Valley, CA 93065
License: CA General Contractor B (758100, 290903), C10 Electrical (947783)

## Products

| Product | Price |
|---------|-------|
| Single Hinged Security Screen Door | ~$1,500+ |
| Double French Security Screen Doors | $3,599 |
| Double Slider Security Screen Doors | $3,699 |
| Fixed Security Screen Windows | $700 |
| Fire Escape Security Screen Windows | $700 |

## Key Value Propositions (use in email content)

* Marine-grade stainless steel mesh — cannot be cut or broken
* 92% of break-ins happen when no one is home
* Protects the most vulnerable entry points: front doors, sliding glass doors, ground-floor windows
* Looks like a regular screen — modern aesthetic, multiple colors, HOA-friendly
* Blocks 66% of UV, allows full airflow and clear views
* Triple interlock locking system
* Lifetime break-in warranty + 10-year frame/mesh warranty
* Free shipping nationwide
* Financing available
* Professional install (LA County), contractor network, or DIY support

## Installation Options

* Professional installation (LA County service area)
* Contractor network (outside LA County)
* DIY with support

## Sales Process

Customers typically:
1. Inquire via website form or phone
2. Receive a quote from a salesperson
3. Purchase online or via phone
4. Schedule installation or receive product for DIY

---

# Background

The company has approximately 40,000 historical leads collected over several years.

Characteristics:

* Leads never purchased.
* Leads are approximately 1–3 years old.
* Audience is mixed: primarily B2C homeowners with a B2B segment (contractors, dealers, builders).
* Each salesperson owns their own customer list.
* Only the assigned salesperson communicates with their leads.
* Website currently has no CRM.
* Goal is to reconnect with historical leads and convert them into customers through intelligent email automation.
* The system must preserve salesperson ownership and generate auditable commission reports.
* Average B2C deal value: $700–$3,699. Average B2B (contractor/dealer) deal value: potentially much higher through recurring orders.

The platform should be designed so it can later become a standalone SaaS product.

---

# Deployment Strategy (Phased Approach)

Given the 3-6 month build time for a full custom platform, the following phased rollout is recommended to generate revenue immediately while the platform is developed.

## Phase 1 — Immediate (Weeks 1-4)

* Clean the contact list using ZeroBounce or NeverBounce before any sending.
* Use Instantly.ai or Smartlead.ai for email sequences and domain warmup.
* Assign unique tracking links per salesperson manually.
* Track replies and commissions in a spreadsheet or Notion.
* Goal: revenue before the platform is built.

## Phase 2 — Medium Term (Months 2-4)

* Build and deploy the custom commission attribution layer (Modules 9-15).
* Connect to the email tool via webhook/API.
* Replace manual tracking with automated lead ownership.

## Phase 3 — Full Platform (Months 4-6)

* Replace the third-party email tool with the custom sending engine (Modules 7-8).
* Full SaaS-ready deployment.
* Domain reputation established by this point.

---

# Email Infrastructure Strategy

## Two Tools for Two Jobs

There are two fundamentally different types of email services. SureSecured needs both — at different stages.

| Type | Purpose | Examples |
|------|---------|---------|
| **Cold Outreach Platform** | Sequences to dormant leads, warmup built-in, reply detection | Instantly.ai, Smartlead.ai |
| **Sending Infrastructure** | Raw delivery API, no sequences, no warmup | Amazon SES, SendGrid, Mailgun |

Amazon SES alone is not suitable for Phase 1. It has no warmup system and no inbox rotation. Sending cold email to 40,000 dormant leads through a fresh SES domain will result in blacklisting within days. SES is used in Phase 3 once domains are established.

---

## Sending Domain Architecture

SureSecured's primary domain (`suresecured.com`) must never be used as a sending domain. All campaign email is sent from dedicated subdomains, one per salesperson:

```
john@mail.suresecured.com
sarah@outreach.suresecured.com
mike@connect.suresecured.com
```

Benefits:
* If a subdomain is flagged, the main domain stays clean
* Each salesperson has an isolated sending reputation
* Warmup runs independently per salesperson
* Easier to identify and suspend a problem sender

Setup: Each subdomain requires a Google Workspace or Microsoft 365 mailbox (~$6-12/mo per inbox) and DNS records (SPF, DKIM, DMARC) configured per subdomain.

---

## Phase 1 — Instantly.ai (Start Here, Weeks 1-16)

**Purpose:** Cold/warm outbound sequences while the custom platform is built.

### Why Instantly.ai

| Feature | Why It Matters for SureSecured |
|---------|-------------------------------|
| Inbox warmup network | Builds subdomain reputation before first send — prevents blacklisting |
| Multiple inbox rotation | Spreads 40k sends across all salesperson inboxes — no single inbox triggers spam filters |
| Daily send limits per inbox | Enforces warmup schedule automatically |
| Reply detection | Stops sequence the moment a lead replies |
| 20-step sequence builder | Matches the required 20-email cadence |
| Bounce handling | Auto-suppresses hard bounces |
| Spam complaint monitoring | Alerts if complaint rate spikes |
| API access | Connects to the custom platform in Phase 2 |

### Instantly.ai vs Smartlead.ai

| | Instantly.ai | Smartlead.ai |
|---|---|---|
| Price | $37/mo (Growth) → $97/mo (Hypergrowth) | $39/mo → $94/mo |
| Warmup network | Large, well-established | Excellent, AI-driven |
| Unlimited inboxes | Hypergrowth plan | Higher plans |
| API access | Yes | Yes |
| Best for | Ease of use | Scale and control |

**Recommendation: Instantly.ai Hypergrowth ($97/mo).** Best warmup network, unlimited inboxes, clean UI, and API available for Phase 2 integration.

### Warmup Schedule (Required Before First Campaign)

Warmup must run for 3-4 weeks on every new sending subdomain before any lead receives a campaign email.

| Week | Emails/Day Per Inbox |
|------|----------------------|
| 1 | 20 |
| 2 | 40 |
| 3 | 80 |
| 4 | 150 |
| 5+ | Scale to daily limit |

Instantly.ai automates this warmup schedule. No manual action required after initial setup.

### Phase 1 Cost Estimate

| Item | Cost/mo |
|------|---------|
| Instantly.ai Hypergrowth | $97 |
| Google Workspace inboxes (per salesperson) | $6-12 each |
| ZeroBounce list verification (one-time) | ~$150 |
| Sending subdomains (annual, amortized) | ~$5 |
| **Total (3 salespeople example)** | **~$130-145/mo** |

---

## Phase 2 — Custom Platform + Instantly.ai API (Months 2-4)

* Custom commission attribution layer is built and connected to Instantly.ai via webhook/API
* Reply events from Instantly.ai trigger lead ownership assignment and salesperson notification
* Click tracking and website attribution run through the custom backend
* Instantly.ai continues handling delivery and warmup

---

## Phase 3 — Custom Platform + Amazon SES (Months 4-6+)

Once sending subdomains have 3-4 months of warmup history and established reputation, the custom platform takes over full delivery through Amazon SES.

### Why SES at This Stage

| | Instantly.ai | Amazon SES |
|---|---|---|
| Cost per 1,000 emails | Included in flat fee | $0.10 |
| At 100k emails/day | ~$97/mo flat | ~$300/mo |
| Warmup | Built-in | You manage (already done) |
| Sequences | Built-in | Your custom platform |
| Reply detection | Built-in | Your custom platform |
| Deliverability tools | Built-in | You manage via custom platform |

At Phase 3 the full stack is:

```
Custom Platform (sequences, tracking, attribution, commission)
        ↓
Amazon SES (raw delivery via SMTP or API)
        ↓
Lead's inbox
```

SES handles volume, cost efficiency, and delivery. The custom platform handles everything else.

### SES Configuration Requirements

* Verified sending domains (each salesperson subdomain)
* DKIM signing per domain
* Dedicated IP addresses (recommended at >50k emails/day — $24.95/mo per IP via SES)
* SES sending limits raised via AWS support request (default is 200/day until raised)
* Bounce and complaint SNS notifications wired to the custom backend
* Suppression list synced between SES and the platform

---

# Business Goals

Primary Goals

* Increase conversions from dormant leads.
* Automate long-term follow-up for both B2C and B2B segments.
* Protect domain reputation.
* Maintain high email deliverability.
* Stop campaigns immediately when customers respond.
* Accurately attribute sales to the originating salesperson.
* Provide complete reporting and analytics.

Success Metrics

* Open Rate >35%
* Reply Rate >8%
* Bounce Rate <2%
* Spam Complaint Rate <0.1%
* Email Deliverability >98%
* Automated Lead Attribution Accuracy 100%
* List Decay Rate (post-verification) <5%
* B2C Average Deal Value: $700–$3,699
* B2B Target: contractor/dealer repeat orders
* Revenue attribution traceable to originating salesperson on 100% of tracked sales

---

# Legal Compliance

## CAN-SPAM (All US recipients)

* Every email must include the company's physical mailing address in the footer.
* Every email must include a one-click unsubscribe link.
* Subject lines must not be deceptive.
* "From" name must accurately identify the sender.
* Opt-outs must be honored within 10 business days.

## GDPR (EU recipients)

* Lawful basis for processing must be documented before emailing EU contacts.
* Data processing records must be maintained.
* Right to erasure must be supported (delete contact on request).
* EU contacts should be flagged in the database and handled separately.

## Email 1 Disclosure (Required)

The first email in every sequence must include a brief explanation of how the recipient's contact information was obtained (e.g., "You inquired about [product] in [year]").

## Audience-Specific Compliance

* B2C: CAN-SPAM applies. Unsubscribe link mandatory. No implied consent from business relationship alone.
* B2B: Slightly more latitude under CAN-SPAM for transactional/commercial relationships, but same unsubscribe requirements apply.

---

# User Roles

## Administrator

Can:

* Manage all salespeople
* Import contacts
* Configure campaigns
* View analytics
* Configure commission rules
* Manage domains
* Configure AI
* View system health
* Override lead ownership (with audit log entry)
* Define sale events

---

## Salesperson

Can:

* View only assigned leads
* Create campaigns
* View replies
* Continue conversations
* See commissions
* See pipeline
* View reports
* Record sale events manually

Cannot:

* View another salesperson's contacts
* Change ownership

---

# Audience Segmentation

## B2C Leads — Homeowners

* Individual homeowners who previously inquired about security screen doors or windows
* Personalization based on: first name, city, product interest (door vs window), original inquiry date
* Email tone: friendly, conversational, safety-focused, benefit-driven
* Primary pain points to address: fear of break-ins, home security for family, aesthetics, HOA concerns, energy savings (UV blocking)
* Key CTAs: Get a Free Quote, See Colors & Styles, Check Financing Options, Book an Install
* Sequence cadence: shorter delays, more emotional/urgency-driven CTAs
* Compliance: CAN-SPAM mandatory

### B2C Email Angle Progression (20-email sequence)

Emails 1-3 (Reconnect): "You looked at us — here's what's changed / still true"
Emails 4-5 (Fear/Safety): Break-in statistics, vulnerable entry points, real consequences
Emails 6-7 (Product Education): How the mesh works, warranty, vs. standard screens
Emails 8-10 (Social Proof): Customer stories, before/after, HOA approvals
Emails 11-13 (Objection Handling): Price justification (cost vs. break-in loss), financing, DIY option
Emails 14-16 (Urgency/Seasonal): Crime stats in their city, summer/holiday season risk
Emails 17-19 (Soft Close): Limited-time offer, free shipping reminder, easy next step
Email 20 (Breakup): "This is my last email — door is always open"

## B2B Leads — Contractors, Dealers, Builders

* General contractors, home security installers, builders, real estate developers, property managers
* Personalization based on: name, company, industry, city
* Email tone: professional, ROI-focused, partnership-oriented, concise
* Primary pain points to address: adding a high-margin product line, differentiating their service offering, upselling existing clients
* Key CTAs: Become a Dealer, Join Contractor Network, Request Wholesale Pricing, Schedule a Call
* Sequence cadence: slightly longer delays, value/ROI-driven CTAs
* Compliance: CAN-SPAM mandatory

### B2B Email Angle Progression (20-email sequence)

Emails 1-3 (Reconnect): "You reached out about partnering — here's our current program"
Emails 4-5 (Revenue Opportunity): Margin per unit, upsell to existing client base
Emails 6-7 (Product Education): Installation specs, SKUs, warranty pass-through for clients
Emails 8-10 (Proof): Contractor testimonials, install case studies, volume examples
Emails 11-13 (Objection Handling): Lead times, support, territory exclusivity questions
Emails 14-16 (Differentiation): How security screens separate them from competitors
Emails 17-19 (Soft Close): Dealer agreement overview, onboarding process, first order incentive
Email 20 (Breakup): Final outreach, referral offer

## Audience Tag

Each contact must be tagged B2C or B2B at import. Campaign builder uses this tag to select the correct email tone, sequence cadence, and angle progression.

Contact record should also store:
* product_interest (door / window / both / unknown)
* install_preference (professional / contractor / DIY / unknown) — B2C only
* company_type (contractor / dealer / builder / property_manager / other) — B2B only

---

# Pre-Launch: List Cleaning (Required Before First Send)

This step is mandatory before any email is sent. Sending to a dirty list will result in high bounce rates and domain blacklisting.

## Process

1. Export the full 40,000-contact list.
2. Upload to ZeroBounce or NeverBounce for bulk verification.
3. Estimated cost: $100-$150 for 40,000 contacts.
4. Estimated discard: 6,000-10,000 invalid addresses (15-25% decay expected on 1-3 year old lists).
5. Remove or suppress all addresses flagged as: Invalid, Disposable, Role-based (info@, support@), Catch-all (flag for manual review), Spam trap.
6. Import only verified or acceptable-risk contacts into the platform.

## Database Fields Added

* email_verified (boolean)
* verification_status (valid / invalid / catch-all / role / disposable / unknown)
* verified_at (timestamp)
* verification_provider (ZeroBounce / NeverBounce)

---

# Landing Page Matrix

Every campaign email must link to the most relevant page — not the homepage. The tracking token's `destination_url` field is set per segment when generating links. This improves conversion and produces cleaner attribution data.

| Segment | Angle | Destination URL |
|---------|-------|----------------|
| B2C + product_interest = door | Product education / quote | `/products/double-french-security-screen-doors` or `/pages/request-a-quote` |
| B2C + product_interest = window | Product education / quote | `/products/fixed-security-screen-windows` or `/pages/request-a-quote` |
| B2C + city in LA County | Professional installation | `/pages/installations` |
| B2C + nationwide / unknown location | DIY / free shipping | `/collections/all` with DIY messaging |
| B2C + high intent (clicked 2x+) | Direct close | `/pages/request-a-quote` or Book a Consultation |
| B2C + financing angle | Remove price objection | `/pages/financing` |
| B2B | Dealer partnership | `/pages/become-a-dealer` |
| B2B + high intent | Direct close | `/pages/become-a-dealer` (all B2B CTAs land here) |

Tracking links are generated per segment — one campaign may produce 5 different destination URLs across its contact list. The commissions and clicks are all attributed back to the salesperson regardless of which URL was used.

---

# Phone Call Attribution

## The Problem

The SureSecured website prominently displays `(747) 688-9992`. A significant portion of leads who receive emails will call instead of replying or submitting a form. Without tracking, these calls are invisible to the commission system — the salesperson who sent the email gets no credit.

## Solution: Per-Salesperson Tracking Numbers (CallRail)

Each salesperson is assigned a unique tracked phone number via CallRail (or similar). These numbers:
- Forward to the main SureSecured line
- Record which number was dialed (identifying the salesperson)
- Log call time, duration, and caller ID
- Integrate with the commission system via webhook

### Implementation

* Each salesperson's email signature includes their unique CallRail number instead of the main business number
* Example: John's emails show `(818) 555-0101` → forwards to `(747) 688-9992` → CallRail logs "John's number was called"
* CallRail webhook fires to `/api/phone-call` on CommissionTracker
* System creates a lead record (if new) and a commission event attributed to that salesperson

### CallRail Cost

~$45/mo for up to 10 tracking numbers with call recording and webhook support.

### Database Addition

```
phone_calls table:
  id, salesperson_id, caller_number, tracking_number,
  duration_seconds, called_at, lead_id (if matched by email/phone)
```

### Priority

Implement after Shopify webhook is confirmed working. This is Phase 2 of the commission engine.

---

# Pre-Campaign List Suppression

Before launching any sequence, export existing Shopify customers and suppress them from the "dormant lead reconnect" campaign. Sending a "we haven't heard from you" email to someone who already purchased is a bad experience.

## Steps

1. Export all customers from Shopify Admin → Customers → Export
2. Upload to the suppression list in CommissionTracker (or ZeroBounce suppression file)
3. These contacts move to a separate **existing customer** list
4. Existing customers get a different sequence: cross-sell (door buyer → window screens, window buyer → door upgrade) rather than the reconnect sequence

## Cross-Sell Sequence (Existing Customers)

* Email 1: "You protected your [doors/windows] — here's what most customers add next"
* Email 2: Product education on the complementary product
* Email 3: Bundle pricing or loyalty offer
* Attribution still applies — original salesperson owns the cross-sell commission

---

# System Architecture

Frontend

Next.js
React
TypeScript
TailwindCSS

Backend

Node.js
Express
TypeScript

Database

PostgreSQL

Queue

Redis
BullMQ

Authentication

JWT
Refresh Tokens

Email

Amazon SES

AI

OpenAI GPT
Provider should be abstracted to allow Gemini, Claude, or local models later.

Deployment

Docker

---

# Core Modules

## Module 1 – Authentication

Features

* Login
* Logout
* Password Reset
* MFA Ready
* Role-based permissions
* Session management

Tables

Users

Fields

id

name

email

password_hash

role

active

created_at

---

# Module 2 – Salesperson Management

Fields

Salesperson ID

Name

Email

Phone

Status

Commission %

Timezone

Signature

Assigned Sending Domain

Assigned Reply Inbox (IMAP credentials or Gmail/Outlook OAuth token)

Daily Sending Limit

Warmup Status

---

# Module 3 – Contact Management

Import

CSV

Excel

Google Sheets

Required Fields

Lead ID

First Name

Last Name

Email

Phone

Company

City

State

Source

Original Inquiry Date

Assigned Salesperson

Audience Type (B2C / B2B)

Status

Optional Fields

Notes

Industry

Role / Job Title

Custom Fields

Vehicle/Product Interested In

Tags

EU Resident Flag

Features

Duplicate detection

Email verification status check (blocks import of unverified contacts)

Invalid email detection

Role address detection

Bounce suppression

Blacklist

Unsubscribe list

GDPR erasure support

---

# Module 4 – Campaign Builder

Visual drag-and-drop builder.

## Sequence Cadence Rules

To protect deliverability and avoid spam complaints, sequences must follow this cadence structure:

Emails 1–7: spaced 3-5 days apart (warm reconnect phase)

Emails 8–12: spaced 7-14 days apart (gentle check-in phase)

Emails 13–20: spaced 25-35 days apart (long-tail nurture phase)

The campaign builder must enforce minimum delay thresholds and warn if a sequence is configured too aggressively.

## Audience-Aware Templates

Campaign builder selects default email tone based on contact's Audience Type tag (B2C or B2B). Salesperson can override per step.

Campaign Components

Delay

Send Email

Condition

Branch

Wait Until

Goal

Exit

Decision

AI Decision

Audience Branch (B2C / B2B fork)

Example Flow

Start

↓

Send Email #1 (Reconnect — personalized by audience type)

↓

Opened?

Yes → Email #2A (Engagement follow-up, 4 days later)

No → Wait 5 Days → Resend Different Subject

↓

Clicked?

Yes → Quote Sequence

No → Educational Sequence

↓

Replied? → STOP ALL AUTOMATION → Notify Salesperson

---

# Module 5 – Email Editor

Supports

HTML

Plain Text

AI Generation

Personalization Variables

B2C Variables:
{{FirstName}}
{{City}}
{{ProductInterest}}         — e.g. "security screen door" or "security screen windows"
{{InstallPreference}}       — e.g. "professional installation" or "DIY"
{{OriginalInquiryDate}}     — e.g. "back in March 2024"
{{Salesperson}}
{{SalespersonPhone}}

B2B Variables:
{{FirstName}}
{{Company}}
{{Industry}}                — e.g. "general contractor" or "home security installer"
{{Role}}
{{City}}
{{OriginalInquiryDate}}
{{Salesperson}}
{{SalespersonPhone}}

AI Features

Rewrite

Shorten

Expand

Professional (default for B2B)

Friendly (default for B2C)

Curiosity Subject Lines

Spam Score Estimation

Tone Selection

CAN-SPAM Footer Auto-Insert (physical address + unsubscribe link)

---

# Module 6 – AI Personalization

Every email generated individually.

Prompt includes

Lead History

Audience Type (B2C homeowner or B2B contractor/dealer)

Location (city — localize crime references or market conditions)

Product Interest (door / window / both)

Industry or Home Context

Previous Inquiry Date

Campaign Stage and Email Number in Sequence

Email Angle for this step (fear / education / social proof / objection / urgency / close)

Salesperson Name and Signature

SureSecured value props relevant to this stage

Generate

Subject line (curiosity-driven, not spammy)

Opening (personal, references their original inquiry or situation)

Body (2-3 short paragraphs max)

CTA (single, clear action)

PS line (optional — humanizes the email)

Compliance footer (CAN-SPAM: physical address + unsubscribe)

Do not repeat previous wording.
Vary sentence structure across sequence steps.
Match tone to audience type automatically.
Never mention competitor products by name.
For B2C: reference home safety, family protection, neighborhood context.
For B2B: reference margin opportunity, client upsell, installation efficiency.

---

# Module 7 – Email Sending Engine

Requirements

SES Integration

Rate Limiting

Automatic Retry

Bounce Detection

Spam Complaint Detection

Sending Windows (business hours only, time zone aware)

Time Zone Awareness

Random Delay Between Sends (humanized pacing)

Warmup Scheduler

Daily Limits Per Salesperson

Example

Monday

8:17 AM

8:42 AM

9:13 AM

instead of every 15 minutes.

## Domain Warmup Schedule

Week 1: 20 emails/day per domain

Week 2: 40 emails/day

Week 3: 80 emails/day

Week 4: 150 emails/day

Week 5+: scale to daily limit

Each salesperson should have a dedicated sending subdomain (e.g., john.company.com) to isolate reputation.

---

# Module 8 – Deliverability

SPF Validation

DKIM Validation

DMARC Validation

Dedicated Sending Subdomain Per Salesperson

Reputation Monitoring

Bounce Tracking

Complaint Tracking

List Hygiene

Automatic Suppression

Unsubscribe Link (required in every email)

One-click unsubscribe (RFC 8058 List-Unsubscribe header)

Blacklist monitoring (MXToolbox or similar)

---

# Module 9 – Website Tracking

Every email contains

https://company.com/r/{tracking_token}

Tracking Token

Random UUID

Maps internally to

Lead

Salesperson

Campaign

Email

Timestamp

Landing Page

Audience Type

Upon click

Store

First Visit

Last Visit

Visit Count

Device

Browser

UTM

Referrer

---

# Module 10 – Visitor Cookie

Cookie Duration

365 Days

Cookie Stores

Tracking Token

Lead ID

Salesperson ID

Campaign ID

Audience Type

First Visit

If visitor returns

Maintain attribution.

---

# Module 11 – Forms

Hidden Fields

Tracking Token

Lead ID

Salesperson ID

Campaign ID

Audience Type

Landing Page

Referrer

Submission Timestamp

Automatic ownership assignment.

---

# Module 12 – Reply Detection

## Inbox Architecture

Each salesperson sends email from their assigned reply inbox. The system monitors each salesperson's inbox using one of:

* IMAP (credentials stored encrypted in the database per salesperson)
* Gmail OAuth (if salesperson uses Gmail)
* Microsoft Graph API (if salesperson uses Outlook/Microsoft 365)

The inbox connection is configured per salesperson in Module 2 (Salesperson Management).

A background worker polls each connected inbox every 2-5 minutes for new replies.

When reply detected

Pause campaign immediately — no further automated emails to this lead

Assign conversation to the salesperson

Notify salesperson via email and browser notification

Create follow-up task

Record timestamp

Tag lead as "Replied"

Run AI Reply Analysis (Module 13)

Update lead score

Never send another automated email to this lead.

---

# Module 13 – AI Reply Analysis

Categories

Hot Lead

Interested

Needs Quote

Appointment

Question

Negative

Not Interested

Already Purchased

Wrong Person

Unsubscribe Request (trigger immediate suppression)

Spam

AI extracts

Intent

Urgency

Requested Product

Requested Appointment

Phone Number

Preferred Contact Time

Confidence Score

Audience Type Confirmation (did they reply as a consumer or business?)

---

# Module 14 – Lead Ownership

Ownership established when

Email Delivered

OR

Link Clicked

OR

Reply Received

Ownership fields

Lead Owner (Salesperson ID)

Campaign

Timestamp

Ownership Source (email_delivered / link_clicked / reply_received / form_submission)

Admin Override (boolean)

Override Reason (text)

Audit Trail (full log of all ownership events)

Ownership cannot change automatically.
Only an Administrator can override ownership, and every override is logged with a reason.

---

# Module 15 – Commission Engine

## Sale Event Definition

A sale is recorded when one of the following events occurs:

1. Manual Entry — Salesperson marks a lead as "Sold" and enters the sale amount in the UI.
2. Form Submission — A purchase or quote-acceptance form is submitted on the website with a valid tracking token (auto-attributed).
3. Payment Webhook — A payment processor (e.g., Stripe) webhook fires with a customer email that matches a tracked lead (auto-attributed).
4. CRM Deal Close — A connected CRM (HubSpot, Salesforce, GoHighLevel) pushes a "deal won" event via webhook.

The Administrator configures which sale event types are active. At minimum, Manual Entry must always be available.

## Commission Rules

Original Salesperson owns commission.

Alternative Rules

100% to original salesperson

70/30 Split (original salesperson / closer)

Custom % split

Administrator configurable per campaign or globally.

## Reports

Sales

Revenue

Commission Earned

Commission Pending

Conversion Rate by Salesperson

Conversion Rate by Campaign

Audience Type Breakdown (B2C vs B2B)

---

# Module 16 – Dashboard

Cards

Contacts

Active Campaigns

Emails Sent Today

Open Rate

Click Rate

Reply Rate

Appointments

Quotes

Sales

Commission

B2C vs B2B Breakdown

Charts

Daily

Weekly

Monthly

Funnels

Campaign Comparison

Salesperson Leaderboard

---

# Module 17 – AI Lead Scoring

Score Components

Email Open: +5

Link Click: +20

Multiple Visits: +20

Pricing Page Visit: +40

Reply: +60

Appointment: +80

Quote Requested: +100

B2B modifier: +10 bonus on all events (B2B leads weighted higher due to deal size)

AI continuously recalculates score.

Priority Queues

Hot

Warm

Cold

Dormant

---

# Module 18 – Notifications

Email

Browser

SMS (future)

Slack (future)

Triggers

Reply Received

Quote Request

Appointment Booked

High Intent Score

Campaign Finished

Bounce Spike

Spam Complaint Spike

Unsubscribe Rate Spike

---

# Module 19 – Reporting

Reports

Salesperson Performance

Campaign Performance

Deliverability Health

Email Health

Reply Analysis

Conversion Funnel

Revenue Attribution

Commission Summary

B2C vs B2B Performance Comparison

List Health (bounce rate, unsubscribe rate, verification status)

Export

CSV

Excel

PDF

---

# Database Schema

Users

Salespeople (includes reply_inbox_type, reply_inbox_credentials_encrypted)

Contacts (includes audience_type, email_verified, verification_status, eu_resident)

Campaigns (includes audience_type, cadence_phase)

CampaignSteps

EmailTemplates (includes audience_type, tone)

EmailVariants

EmailEvents

WebsiteVisits

Replies

ReplyAnalysis

LeadScores

LeadOwnership (includes ownership_source, admin_override, override_reason)

Tasks

Sales (includes sale_event_type, amount, salesperson_id, lead_id)

Commissions

AuditLog

Settings

Domains

SendingAccounts

SuppressionList

Unsubscribes

EmailVerificationResults

---

# API

REST

Future GraphQL

Endpoints

/auth

/users

/contacts

/campaigns

/emails

/replies

/tracking

/reports

/commissions

/settings

/webhooks (payment processors, CRM deal events)

/verification (email verification status)

---

# Background Workers

Queue

Email Send

Email Retry

AI Generation

Bounce Processing

Reply Inbox Polling (per salesperson, every 2-5 min)

Reply Processing

Score Calculation

Analytics

Scheduled Campaigns

Warmup Scheduler

List Cleanup

Blacklist Monitor

---

# Security

Encrypted passwords

Encrypted inbox credentials (salesperson IMAP/OAuth tokens AES-256)

HTTPS only

Rate limiting

CSRF protection

Input validation

SQL injection prevention

XSS prevention

Audit logs (all ownership changes, admin overrides, sale entries)

JWT expiration

Role-based permissions

---

# Off-the-Shelf Tool Reference (Phase 1 & 2)

The following tools are recommended for the phased deployment strategy while the custom platform is built.

## Email Sending & Sequences

| Tool | Best For | Cost/mo |
|------|----------|---------|
| Instantly.ai | Warmup + sequences, best deliverability tooling | $37-97 |
| Smartlead.ai | Multi-inbox, strong warmup | $39-79 |
| Lemlist | Personalization + sequences | $59-99 |

## List Verification

| Tool | Notes | Cost |
|------|-------|------|
| ZeroBounce | Best accuracy, detailed results | ~$120 for 40k |
| NeverBounce | Strong alternative | ~$100 for 40k |
| Kickbox | Good for ongoing verification | Pay-per-use |

## CRM (Optional Phase 1)

| Tool | Notes | Cost/mo |
|------|-------|---------|
| HubSpot Free | Basic pipeline, no sequences | Free |
| Pipedrive | Clean pipeline UI | $15-49 |
| GoHighLevel | All-in-one, closest to full PRD | $97-297 |

Note: No off-the-shelf tool replicates the immutable lead ownership + auditable commission attribution described in this PRD. That is the core custom differentiator.

---

# Open Integration Questions

These items need a decision before full launch. Each affects commission attribution.

| Item | Question | Impact |
|------|----------|--------|
| "Book a Consultation" | Is this Calendly, a Shopify app, or phone-only? | If Calendly: needs webhook to CommissionTracker. If phone-only: covered by CallRail. |
| Quote form tool | Is it Typeform, JotForm, or native Shopify? | Determines how hidden fields are injected for attribution. |
| Financing page | Is it Affirm, Shop Pay, or a third party? | If third-party checkout: cart attribution cookie may not carry through. Needs testing. |
| Shopify snippet | Has it been added to theme.liquid by the Shopify developer? | Without it: clicks are tracked but form submissions and purchases are NOT attributed. **Blocking for commission accuracy.** |

---

# Future Features

SMS campaigns

Voice AI follow-up

AI phone calls

Calendar booking (Calendly-style embedded)

CRM integration

HubSpot integration

Salesforce integration

GoHighLevel integration

WhatsApp

Facebook Messenger

LinkedIn outreach

Multi-company SaaS

Subscription billing

White labeling

AI campaign optimization

Predictive lead scoring

Automatic A/B testing

---

# Non-Functional Requirements

Support

1,000,000 contacts

100,000 emails/day

99.9% uptime

Average API latency: <250 ms

Campaign builder response: <100 ms

Database backups every hour

Structured logging

Health monitoring

Dockerized deployment

Horizontal scalability

---

# Acceptance Criteria

* Users can securely log in with role-based permissions.
* Contact list is verified via ZeroBounce or NeverBounce before the first campaign launches; unverified contacts are blocked from sending.
* Administrators can import and manage contact lists with duplicate detection, email verification, and audience type tagging (B2C / B2B).
* Salespeople can access only their assigned leads.
* Campaigns support branching logic, audience-type forks, enforced cadence delays, and AI-generated content matched to audience tone.
* Emails are personalized per recipient and audience type, sent through Amazon SES with rate limiting and warm-up controls.
* Every email includes a CAN-SPAM-compliant footer (physical address + one-click unsubscribe).
* Campaigns automatically stop when a reply is received, with immediate salesperson notification.
* Every tracked click and website visit is attributed to the originating salesperson using secure tracking tokens.
* Hidden form fields preserve attribution through inquiries.
* AI classifies replies and scores leads based on engagement.
* Lead ownership is immutable unless explicitly overridden by an Administrator, with full audit log.
* Sale events are recorded via at least one configured trigger (manual entry, form submission, payment webhook, or CRM event).
* Commission reports accurately attribute conversions to the originating salesperson with configurable split rules.
* Salesperson reply inboxes are monitored via IMAP or OAuth with credentials stored encrypted.
* Dashboards provide real-time analytics on deliverability, engagement, conversions, revenue, and B2C vs B2B performance.
* The application is fully containerized with Docker and designed to support future multi-tenant SaaS deployment.
