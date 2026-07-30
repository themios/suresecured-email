const test = require('node:test');
const assert = require('node:assert');
const { classifyLabels } = require('./seedCanary');

// classifyLabels is the one piece of the seed canary that is pure logic (no
// network, no DB) and therefore the one worth unit testing directly; the rest
// is only verifiable against a live connected Gmail account.

test('a message in Spam is spam, even if other category labels are also present', () => {
  assert.strictEqual(classifyLabels(['SPAM', 'CATEGORY_PROMOTIONS']), 'spam');
});

test('a message only in Promotions is promotions', () => {
  assert.strictEqual(classifyLabels(['CATEGORY_PROMOTIONS']), 'promotions');
});

test('a message in the primary inbox with no category label is inbox', () => {
  assert.strictEqual(classifyLabels(['INBOX']), 'inbox');
});

test('a message under Updates/Social/Forums still counts as reaching them (inbox)', () => {
  assert.strictEqual(classifyLabels(['INBOX', 'CATEGORY_UPDATES']), 'inbox');
  assert.strictEqual(classifyLabels(['CATEGORY_SOCIAL']), 'inbox');
});

test('no labels at all still classifies as inbox rather than throwing', () => {
  assert.strictEqual(classifyLabels([]), 'inbox');
  assert.strictEqual(classifyLabels(undefined), 'inbox');
});
