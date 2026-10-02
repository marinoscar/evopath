// =============================================================================
// providerFileName — the name a storage-object input is sent to a provider under
// =============================================================================
//
// A storage object's `name` is whatever the user's file was called, e.g.
// `Lab Results - Oct 1 2026.PDF`. Some providers detect a file's type from
// its extension, case-sensitively: OpenAI's Files API rejects `.PDF` with an
// HTTP 400 (issue #301). Every provider therefore receives a normalised name:
//
//   - no directory path, only the base name (trimmed; `file` when empty);
//   - the extension lower-cased;
//   - when the MIME type has a canonical extension (`extensionForMime`), the
//     name ends in it — a missing or mismatched extension gets it appended.
//     Common aliases of a canonical extension (`jpeg` for `jpg`) are kept.
//
// The storage object itself is never renamed; this is only the wire name.
// =============================================================================

import { extensionForMime } from '../storage/ai-output-writer';

/** Extensions accepted as-is for a MIME type whose canonical extension is the key. */
const EXTENSION_ALIASES: Record<string, readonly string[]> = {
  jpg: ['jpeg', 'jpe'],
  mp3: ['mpga', 'mpeg'],
  wav: ['wave'],
  ogg: ['oga'],
};

/** The name `name` (of a file of type `mimeType`) is sent to a provider under. */
export function providerFileName(name: string | undefined, mimeType: string): string {
  const base = (name ?? '').split(/[\\/]/).pop()?.trim().replace(/\.+$/, '') || 'file';
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && dot < base.length - 1;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot + 1).toLowerCase() : '';
  const normalised = hasExt ? `${stem}.${ext}` : base;

  const canonical = extensionForMime(mimeType);

  if (canonical === 'bin') return normalised;
  if (ext === canonical || EXTENSION_ALIASES[canonical]?.includes(ext)) return normalised;

  return `${normalised}.${canonical}`;
}
