/**
 * Email-safe font stacks for tenant Theme & Branding settings. Deliberately
 * NOT arbitrary web/Google fonts -- most email clients (Outlook desktop,
 * many mobile mail apps) strip @font-face/webfont loading entirely and fall
 * back to a client default, so a font picker here can only offer stacks
 * every major client already renders correctly. A tenant picks a label; we
 * control the actual fallback chain.
 */
const FONT_STACKS = {
  helvetica: { label: 'Helvetica / Arial',        stack: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
  georgia:   { label: 'Georgia (serif)',          stack: "Georgia,'Times New Roman',serif" },
  times:     { label: 'Times New Roman (serif)',  stack: "'Times New Roman',Times,serif" },
  verdana:   { label: 'Verdana',                  stack: "Verdana,Geneva,sans-serif" },
  tahoma:    { label: 'Tahoma',                   stack: "Tahoma,Geneva,sans-serif" },
  trebuchet: { label: 'Trebuchet MS',              stack: "'Trebuchet MS',Helvetica,sans-serif" },
  courier:   { label: 'Courier New (monospace)',  stack: "'Courier New',Courier,monospace" },
};

const DEFAULT_FONT_KEY = 'helvetica';

function isValidFontKey(key) {
  return Object.prototype.hasOwnProperty.call(FONT_STACKS, key);
}

function resolveFontStack(key) {
  return (FONT_STACKS[key] || FONT_STACKS[DEFAULT_FONT_KEY]).stack;
}

// Per-area size bounds. Areas mirror the existing 3-way color grouping
// (primary=header, accent=button/body links, bg=signature+footer) so fonts
// and colors follow the same mental model instead of adding a fourth concept.
const SIZE_RANGES = {
  header: { min: 14, max: 32, default: 20 },
  body:   { min: 12, max: 22, default: 15 },
  sig:    { min: 10, max: 18, default: 14 },
};

function clampFontSize(area, value) {
  const range = SIZE_RANGES[area] || SIZE_RANGES.body;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

module.exports = { FONT_STACKS, DEFAULT_FONT_KEY, isValidFontKey, resolveFontStack, SIZE_RANGES, clampFontSize };
