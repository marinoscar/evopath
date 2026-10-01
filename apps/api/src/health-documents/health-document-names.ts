// =============================================================================
// Health document names: sanitising a rename, and a safe Content-Disposition
// =============================================================================
// (H6, #190)
//
// A document name is user-supplied text that ends up in two dangerous places:
// a list a browser renders, and the `Content-Disposition` a storage provider
// returns with the file. So:
//
//   - `sanitizeDocumentName` (every rename): drops C0/C1 control characters and
//     the Unicode direction overrides that let `evil\u202Efdp.exe` display as
//     `evilexe.pdf`, turns path separators into `_`, collapses whitespace and
//     trims. Pure; the length cap is the DTO's.
//   - `contentDispositionOf` (every download link): the RFC 6266 header with
//     an ASCII `filename="…"` fallback (no quote, backslash, `%` or `;` can
//     reach it) and the exact name as RFC 5987 `filename*=UTF-8''…`.
//
// ⚠ Never log a document name.
// =============================================================================

import type { DownloadDisposition } from './dto/health-document.dto';

// C0 and C1 control characters, DEL, and the bidi embedding/override/isolate
// marks (U+202A-U+202E, U+2066-U+2069) plus LRM/RLM/ALM.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

// A lone surrogate cannot be percent-encoded (`encodeURIComponent` throws).
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The fallback when nothing printable is left of a name. */
export const DEFAULT_DOWNLOAD_NAME = 'document';

/** A user-supplied document name made safe to store and display (length is the caller's concern). */
export function sanitizeDocumentName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(LONE_SURROGATES, '')
    .replace(UNSAFE_CHARACTERS, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The name a download serves: sanitised, and never empty. */
export function downloadNameOf(name: string): string {
  return sanitizeDocumentName(name) || DEFAULT_DOWNLOAD_NAME;
}

/** RFC 5987 `attr-char` percent-encoding: `encodeURIComponent` minus the characters it leaves but 5987 forbids. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Printable ASCII only, and none of the characters that could break out of a quoted-string. */
function asciiFallbackOf(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\%;]/g, '_')
    .trim();
  return ascii || DEFAULT_DOWNLOAD_NAME;
}

/** `inline; filename="report.pdf"; filename*=UTF-8''report.pdf` for any name. */
export function contentDispositionOf(disposition: DownloadDisposition, name: string): string {
  const safe = downloadNameOf(name);
  return `${disposition}; filename="${asciiFallbackOf(safe)}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}

/**
 * Types a browser may render inline from the storage origin. Anything else
 * (an SVG or HTML file that slipped in, an unknown type) is served as an
 * attachment whatever the caller asked for.
 */
const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

export function effectiveDisposition(requested: DownloadDisposition, mimeType: string): DownloadDisposition {
  return requested === 'inline' && INLINE_MIME_TYPES.has(mimeType.toLowerCase()) ? 'inline' : 'attachment';
}
