/**
 * Public legal documents (privacy policy, terms of service).
 *
 * Source of truth is the markdown at the repo root, so counsel edits one file
 * and the published page follows. Internal-only annotations are stripped on
 * load: the DRAFT status banner, the `[reference: src/...]` code pointers that
 * exist to show a lawyer where a claim comes from, and the trailing "Open items"
 * checklist.
 *
 * Unfinished `[Counsel to draft ...]` placeholders are NOT hidden — an
 * incomplete document that looks finished is worse than an obviously incomplete
 * one. They are collapsed to a neutral "being finalized" marker instead, because
 * the raw placeholders name internal planning docs (BUILD_PLAN.md,
 * PRICING_STRATEGY.md) that must not appear on a public page. Once counsel fills
 * them in there are no bracketed spans left and the rule becomes a no-op.
 */
const fs   = require('fs');
const path = require('path');

const DOCS = {
  privacy: {
    file:  'PRIVACY_POLICY_DRAFT.md',
    slug:  '/privacy',
    title: 'Privacy Policy',
    description: 'How SalesWyze collects, uses, and retains data for business customers and their contacts.',
  },
  terms: {
    file:  'TERMS_OF_SERVICE_DRAFT.md',
    slug:  '/terms',
    title: 'Terms of Service',
    description: 'The terms governing use of the SalesWyze platform.',
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Strip the internal-only scaffolding a public reader should never see.
function stripInternal(md) {
  return md
    // "**STATUS: DRAFT — ...**" banner and the paragraph explaining the draft exists for counsel.
    .replace(/^\*\*STATUS:[^\n]*\*\*\s*\n+(?:(?!^#|^---)[^\n]+\n)*/gm, '')
    // Inline `[reference: src/foo.js]` pointers.
    .replace(/\s*`?\[reference:[^\]]*\]`?/g, '')
    // Trailing "Open items before this can be published" checklist.
    .replace(/\n---\s*\n+\*\*Open items[\s\S]*$/m, '\n')
    // Unfinished placeholders -> neutral marker. The raw text names internal
    // planning docs, so it cannot be published verbatim; the gap stays visible.
    .replace(/\[[^\]\n]{12,}\]/g, '{{PENDING}}')
    .trim();
}

// Minimal markdown -> HTML for the subset these documents use: headings,
// bold, inline code, links, unordered/ordered lists, hr, paragraphs.
function renderMarkdown(md) {
  const inline = (s) => esc(s)
    .replace(/\{\{PENDING\}\}/g, '<em class="legal-pending">[This section is being finalized with counsel.]</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');

  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim())            { closeList(); continue; }
    if (/^---+$/.test(line))     { closeList(); out.push('<hr>'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h)                       { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }

    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul)                      { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }

    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol)                      { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// Read once at boot — these change on deploy, not at runtime.
const cache = {};
for (const [key, meta] of Object.entries(DOCS)) {
  const full = path.join(__dirname, '..', '..', meta.file);
  try {
    const body = renderMarkdown(stripInternal(fs.readFileSync(full, 'utf8')));
    cache[key] = { ...meta, html: body };
  } catch (err) {
    console.warn(`[legalDocs] could not load ${meta.file}: ${err.message}`);
  }
}

const getDoc = (key) => cache[key] || null;

module.exports = { DOCS, getDoc, renderMarkdown, stripInternal };
