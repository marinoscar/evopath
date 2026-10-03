// =============================================================================
// stripMarkdown — coach markdown reduced to plain text (#343)
// =============================================================================
//
// The coach chat replies in light markdown (`**19 working sets**`, short
// bullet lists), and the web app renders it. Every surface that is NOT
// rendered markdown — the text-to-speech script, a push or browser
// notification, an email subject line, a guard scan — reads the text through
// this function, so a `**` or a `|---|` is never read aloud or shown raw.
//
// The STORED message body is never rewritten with it: the web renders the
// markdown.
//
// Pure, no dependencies. Handled: bold / italic / strikethrough, ATX and
// setext headings, list markers (bullets, task boxes; ordered numbers kept by
// default), blockquotes, inline code and fenced code (content kept, fences
// dropped), links and images (`[t](u)` -> `t`, reference links, autolinks),
// reference definitions, tables (rows read as `Header: cell, Header: cell`),
// horizontal rules, `<br>`, backslash escapes. Numbers and units are never
// touched: `**45 kg**` -> `45 kg`, `5 * 3` and `snake_case` stay as written.
// =============================================================================

export interface StripMarkdownOptions {
  /**
   * Keep an ordered list's `1.` marker (default true): plain-text readers keep
   * the order. The content guard passes false, so a list's ordinal is never
   * scanned as a figure the coach made up.
   */
  keepOrderedMarkers?: boolean;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HR = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^\s{0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)[ \t]*$/;
const BLOCKQUOTE = /^\s{0,3}(?:>[ \t]?)+/;
const BULLET = /^(\s*)[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/;
const ORDERED = /^(\s*)(\d{1,9})([.)])[ \t]+/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$|^\s*\|\s*:?-{1,}:?\s*\|\s*$/;

/** `text` with its markdown syntax removed; the words, numbers and units unchanged. */
export function stripMarkdown(text: string, options: StripMarkdownOptions = {}): string {
  if (!text) return '';
  const keepOrdered = options.keepOrderedMarkers !== false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  let fence: string | null = null;
  let table: { header: string[] | null } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: the fences go, the content stays verbatim.
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
        fence = null;
      } else {
        out.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    // Tables: a header row followed by a separator row starts one.
    if (table === null && isTableRow(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      table = { header: tableCells(line).map((cell) => inline(cell)) };
      i++; // the separator row
      continue;
    }
    if (table !== null) {
      if (isTableRow(line)) {
        out.push(tableRow(table.header, tableCells(line).map((cell) => inline(cell))));
        continue;
      }
      table = null;
    }
    if (TABLE_SEPARATOR.test(line) && line.includes('|')) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      out.push(tableRow(null, tableCells(line).map((cell) => inline(cell))));
      continue;
    }

    if (HR.test(line)) {
      // `text\n---` is a setext heading; the underline goes either way.
      out.push('');
      continue;
    }
    if (SETEXT_UNDERLINE.test(line) && out.length > 0 && out[out.length - 1].trim() !== '' && /=/.test(line)) continue;
    if (REFERENCE_DEFINITION.test(line)) continue;

    let rest = line;
    const heading = ATX_HEADING.exec(rest);
    if (heading) rest = heading[1] ?? '';
    rest = rest.replace(BLOCKQUOTE, '');
    const bullet = BULLET.exec(rest);
    if (bullet) {
      rest = rest.slice(bullet[0].length);
    } else {
      const ordered = ORDERED.exec(rest);
      if (ordered) rest = (keepOrdered ? `${ordered[2]}${ordered[3]} ` : '') + rest.slice(ordered[0].length);
    }
    out.push(inline(rest).replace(/[ \t]+$/, ''));
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && !/^`/.test(trimmed);
}

function tableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** One table row as text: `Header: cell, Header: cell` when the header fits, else the cells. */
function tableRow(header: string[] | null, cells: string[]): string {
  const filled = cells.map((cell, index) => ({ cell, label: header?.[index] ?? '' })).filter(({ cell }) => cell !== '');
  if (header && header.length === cells.length) {
    return filled.map(({ cell, label }) => (label ? `${label}: ${cell}` : cell)).join(', ');
  }
  return filled.map(({ cell }) => cell).join(', ');
}

// Private-use placeholders: code spans and escapes are set aside so the
// emphasis rules never see their characters.
const HOLD_OPEN = '';
const HOLD_CLOSE = '';

/** The inline syntax of one line removed. */
function inline(text: string): string {
  const held: string[] = [];
  const hold = (value: string): string => `${HOLD_OPEN}${held.push(value) - 1}${HOLD_CLOSE}`;

  let s = text
    // Code spans first: their content is literal.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => hold(code.trim()))
    // Backslash escapes: the character itself, literally.
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_m, ch: string) => hold(ch))
    .replace(/<br\s*\/?>/gi, ' ')
    // Images and links: the visible text only.
    .replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, '$1')
    .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1');

  // Emphasis, strongest first; a marker must hug its text, so `5 * 3` stays.
  s = s
    .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1$2');

  return s.replace(new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g'), (_m, index: string) => held[Number(index)] ?? '');
}
