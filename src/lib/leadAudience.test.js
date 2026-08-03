/**
 * node --test src/lib/leadAudience.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifyAudience } = require('./leadAudience');

test('web form type always wins over any inference', () => {
  // A dealer applicant using a gmail address must still route B2B.
  assert.equal(classifyAudience({ formType: 'dealer', email: 'joe@gmail.com' }).audience, 'B2B');
  // A quote request from a business domain is still a homeowner buying a screen.
  assert.equal(classifyAudience({ formType: 'quote', email: 'joe@acmecorp.com' }).audience, 'B2C');
});

test('intent keywords beat the sender domain', () => {
  const r = classifyAudience({ email: 'joe@gmail.com', subject: 'Interested in becoming a dealer' });
  assert.equal(r.audience, 'B2B');
  assert.equal(r.reason, 'intent_keyword');

  assert.equal(classifyAudience({ email: 'sue@yahoo.com', body: 'Do you offer wholesale pricing?' }).audience, 'B2B');
  assert.equal(classifyAudience({ email: 'k@aol.com', body: 'I am a contractor in Simi Valley' }).audience, 'B2B');
});

test('free-mail domains default to B2C', () => {
  for (const e of ['a@gmail.com', 'b@yahoo.com', 'c@aol.com', 'd@icloud.com', 'e@comcast.net']) {
    const r = classifyAudience({ email: e, subject: 'Quote please' });
    assert.equal(r.audience, 'B2C', e);
    assert.equal(r.reason, 'free_mail_domain');
  }
});

test('business domains default to B2B', () => {
  const r = classifyAudience({ email: 'buyer@acmesecurity.com', subject: 'Pricing' });
  assert.equal(r.audience, 'B2B');
  assert.equal(r.reason, 'business_domain');
});

test('homeowner language rescues a business-domain sender', () => {
  // Someone emailing from work about their own house is not a dealer.
  const r = classifyAudience({ email: 'jane@lawfirm.com', body: 'I need a screen for my patio door at my house' });
  assert.equal(r.audience, 'B2C');
  assert.equal(r.reason, 'homeowner_language');
});

test('missing or malformed address falls back to B2C', () => {
  assert.equal(classifyAudience({}).audience, 'B2C');
  assert.equal(classifyAudience({ email: 'not-an-address' }).audience, 'B2C');
  assert.equal(classifyAudience({ email: '' }).audience, 'B2C');
});

test('real submissions from the July 12 backlog route correctly', () => {
  assert.equal(classifyAudience({ formType: 'dealer', email: 'mikezamora216@gmail.com' }).audience, 'B2B');
  assert.equal(classifyAudience({ formType: 'dealer', email: 'mommyandavery01@aol.com' }).audience, 'B2B');
  assert.equal(classifyAudience({ formType: 'dealer', email: null }).audience, 'B2B');
});
