/**
 * Markdown helpers for model-written text (issue #343).
 *
 * `safeMarkdownHref` is the link policy `components/common/MarkdownText.tsx`
 * applies to every `href`: only `http:`, `https:` and `mailto:` URLs, plus
 * root-relative in-app paths, survive. Anything else (`javascript:`, `data:`,
 * `vbscript:`, protocol-relative `//host`, bare relative paths) is dropped and
 * the link renders as plain text.
 *
 * `stripMarkdown` turns a markdown string into one line of plain text for the
 * places that show a preview (the Today `CoachHero` strip, `title`
 * attributes): no asterisks, backticks, heading hashes or list markers.
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
// Browsers strip ASCII tab/newline from URLs and read `\` as `/`, so either
// can turn an innocent-looking path into `//evil.example` or a scheme.
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f\\]/;

/** The href to render, or `undefined` when the link must not be clickable. */
export function safeMarkdownHref(href: string | null | undefined): string | undefined {
  if (typeof href !== 'string') return undefined;
  const value = href.trim();
  if (value === '' || UNSAFE_URL_CHARS.test(value)) return undefined;
  if (value.startsWith('/')) return value.startsWith('//') ? undefined : value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? value : undefined;
}

/** Is this (already sanitized) href an external URL that opens in a new tab? */
export function isExternalHref(href: string): boolean {
  return /^https?:/i.test(href);
}

/**
 * Markdown to a single line of plain text. Deliberately small and regex-based:
 * it is for previews, where a stray character is harmless and an asterisk is
 * not. Snake_case words keep their underscores.
 */
export function stripMarkdown(markdown: string | null | undefined): string {
  if (!markdown) return '';
  return (
    markdown
      // Fenced code: keep the code, drop the fences (and any language tag).
      .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
      // Images: alt text. Links: label. Autolinks: the URL.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<((?:https?:|mailto:)[^>\s]+)>/gi, '$1')
      // Table separator rows (|---|:--:|), then the remaining pipes.
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
      .replace(/^\s*\|/gm, '')
      .replace(/\|\s*$/gm, '')
      .replace(/\s*\|\s*/g, ' · ')
      // Block markers at line start: headings, quotes, rules, list bullets, task boxes.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
      // Inline emphasis, strikethrough and code.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/`+([^`]*)`+/g, '$1')
      // Any emphasis markers left unpaired (e.g. a streaming `**`).
      .replace(/\*{2,}|~~/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
