# SalesWyze Data Processing Agreement (DPA)

**STATUS: DRAFT — NOT LEGAL ADVICE. Do not publish or sign until reviewed and approved by a licensed attorney.**

A DPA formalizes the processor/controller relationship implied throughout the Terms of Service and Privacy Policy drafts: the business customer is the data controller (they decide who gets contacted and why); Sure Secured is the data processor (we act on their instructions). This matters most once a business customer asks "will you sign a DPA" — an enterprise buyer's security/legal team will ask this before they ask anything else.

---

## 1. Roles

- **Controller:** the business customer, who determines the purposes and means of processing their contacts' personal data.
- **Processor:** Sure Secured (SalesWyze), who processes that data only per the controller's instructions (encoded as: the campaigns and lists the controller configures).

## 2. Scope of processing

- **Subject matter:** email delivery, engagement tracking (opens/clicks/replies), and (once live) SMS/voice delivery, on behalf of the controller.
- **Duration:** for the term of the controller's subscription, plus any post-termination retention period defined in the Terms of Service.
- **Nature and purpose:** sending and tracking marketing/follow-up communications the controller configures.
- **Categories of data:** name, email, phone, city, engagement/interaction data. `[reference: src/db.js leads table and related engagement tables]`
- **Categories of data subjects:** the controller's leads and past customers.

## 3. Processor obligations

- Process personal data only on the controller's documented instructions (i.e., the campaigns they configure), except where required by law.
- Ensure personnel with access are bound by confidentiality.
- Implement appropriate technical and organizational security measures. Current measures include: encrypted connections, encrypted credential storage for connected mailboxes, per-tenant data isolation enforced at the query layer and covered by an automated test suite, and an audit log of authentication and sensitive account-change events. `[reference: src/test/isolation.test.js, src/lib/auditLog.js]`
- Assist the controller in responding to data subject requests (access, deletion). A working deletion path exists for removing a contact's data on request. `[reference: src/lib/dataDeletion.js]`
- Notify the controller without undue delay upon becoming aware of a personal data breach. [Counsel: define the specific notification timeline — commonly 72 hours to align with GDPR-style obligations, or per the strictest applicable state breach-notification law.]
- Not engage a sub-processor without the controller's authorization. [List current sub-processors here once finalized — e.g., the hosting provider (Railway), the email sending provider, any SMS/voice vendor once Phase 1.5 ships, any list-verification vendor.]
- Delete or return all personal data at the end of the engagement, at the controller's choice, subject to the financial-record retention carve-out described in the Privacy Policy.

## 4. Sub-processors (fill in before publishing)

| Sub-processor | Purpose | Data involved |
|---|---|---|
| [Hosting provider] | Application hosting | All platform data |
| [Email sending provider] | Email delivery | Contact email addresses, message content |
| [SMS/voice provider, once live] | SMS/voice delivery | Contact phone numbers |
| [List verification provider, if used] | Email verification | Contact email addresses |

## 5. International transfers

[Counsel: address if any sub-processor or infrastructure is outside the controller's jurisdiction; add SCCs or equivalent if needed.]

## 6. Audits

The controller may request evidence of compliance with this DPA [counsel to define reasonable audit rights and frequency].

---

**Open items before this can be published or signed:**
1. Fill in the sub-processor table with actual vendor names once finalized.
2. Set a specific breach-notification timeline.
3. Confirm whether any cross-border data transfer provisions are needed.
4. Have counsel review before this is offered to any enterprise customer.
