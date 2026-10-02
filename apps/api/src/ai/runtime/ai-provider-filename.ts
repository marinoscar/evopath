// =============================================================================
// providerFileName — the name a storage-object input is sent to a provider under
// =============================================================================
//
// A storage object's `name` is whatever the user's file was called, e.g.
// `Result Trends - COMPREHENSIVE METABOLIC PANEL - Oct 1 2026.PDF`. A provider
// rejected exactly that file with an HTTP 400 and accepted the same bytes
// renamed `lipid_panel.pdf` (issue #301, confirmed by the user's test). That
// rename changed both the extension's case and the characters of the name, so
// every provider receives a name normalised on both counts:
//
//   - no directory path, only the base name;
//   - the stem slugged: NFKD-normalised with diacritics stripped, every run of
//     characters outside [A-Za-z0-9._-] replaced by one `_`, repeated `_`
//     collapsed, leading/trailing `_ . -` trimmed, capped at 100 characters,
//     and `file` when nothing is left;
//   - the extension lower-cased;
//   - when the MIME type has a canonical extension (`extensionForMime`), the
//     name ends in it — a missing or mismatched extension gets it appended.
//     Common aliases of a canonical extension (`jpeg` for `jpg`) are kept.
//
// The stored object is never renamed; this is only the wire name.
// =============================================================================

import { extensionForMime } from '../storage/ai-output-writer';

/** Extensions accepted as-is for a MIME type whose canonical extension is the key. */
const EXTENSION_ALIASES: Record<string, readonly string[]> = {
  jpg: ['jpeg', 'jpe'],
  mp3: ['mpga', 'mpeg'],
  wav: ['wave'],
  ogg: ['oga'],
};

/** Longest stem (the name without its extension) sent to a provider. */
const MAX_STEM_LENGTH = 100;

const EDGE_PUNCTUATION = /^[_.-]+|[_.-]+$/g;

/** `stem` reduced to [A-Za-z0-9._-], at most MAX_STEM_LENGTH characters; `file` when empty. */
function slugStem(stem: string): string {
  const slug = stem
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(EDGE_PUNCTUATION, '')
    .slice(0, MAX_STEM_LENGTH)
    .replace(EDGE_PUNCTUATION, '');
  return slug || 'file';
}

/** The name `name` (of a file of type `mimeType`) is sent to a provider under. */
export function providerFileName(name: string | undefined, mimeType: string): string {
  const base = (name ?? '').split(/[\\/]/).pop()?.trim().replace(/\.+$/, '') ?? '';
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';
  const hasExt = /^[A-Za-z0-9]+$/.test(rawExt);
  const stem = slugStem(hasExt ? base.slice(0, dot) : base);
  const ext = hasExt ? rawExt.toLowerCase() : '';
  const normalised = hasExt ? `${stem}.${ext}` : stem;

  const canonical = extensionForMime(mimeType);

  if (canonical === 'bin') return normalised;
  if (ext === canonical || EXTENSION_ALIASES[canonical]?.includes(ext)) return normalised;

  return `${normalised}.${canonical}`;
}
