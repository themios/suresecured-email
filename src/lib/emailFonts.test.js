const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveFontStack, isValidFontKey, clampFontSize, FONT_STACKS, DEFAULT_FONT_KEY } = require('./emailFonts');

test('resolveFontStack returns the matching stack for a known key', () => {
  assert.equal(resolveFontStack('georgia'), FONT_STACKS.georgia.stack);
});

test('resolveFontStack falls back to the default for an unknown/missing key', () => {
  assert.equal(resolveFontStack('comic-sans'), FONT_STACKS[DEFAULT_FONT_KEY].stack);
  assert.equal(resolveFontStack(undefined), FONT_STACKS[DEFAULT_FONT_KEY].stack);
});

test('isValidFontKey only accepts known keys', () => {
  assert.equal(isValidFontKey('verdana'), true);
  assert.equal(isValidFontKey('nope'), false);
});

test('clampFontSize keeps an in-range value', () => {
  assert.equal(clampFontSize('body', 16), 16);
});

test('clampFontSize clamps out-of-range values to the area bounds', () => {
  assert.equal(clampFontSize('header', 4), 14);
  assert.equal(clampFontSize('header', 999), 32);
});

test('clampFontSize falls back to the area default for missing/invalid input', () => {
  assert.equal(clampFontSize('sig', undefined), 14);
  assert.equal(clampFontSize('sig', 'not-a-number'), 14);
});

test('clampFontSize defaults to the body range for an unknown area', () => {
  assert.equal(clampFontSize('nonsense', undefined), 15);
});
