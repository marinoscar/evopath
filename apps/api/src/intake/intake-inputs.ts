import { inflateSync } from 'node:zlib';

import {
  AI_STORAGE_INPUT_FILE_MAX_BYTES,
  AI_STORAGE_INPUT_IMAGE_MAX_BYTES,
  AI_STORAGE_INPUT_IMAGE_MIME_TYPES,
} from '../ai/core/types/file-inputs.types';
import { detectImageType } from '../common/profile-image/profile-image';
import { mimeTypeMatches, normaliseMimeType } from '../storage/mime-type-match';

// =============================================================================
// Intake inputs: which files a kind accepts, and what a file really is (H2, #186)
// =============================================================================
//
// An intake kind declares `acceptedInputs` (`['image']` by default, or
// `['image', 'pdf']`). Attaching a file is checked in three layers, cheapest
// first, so the user hears about a bad file at attach time, before any AI
// call:
//
//   1. the DECLARED type (the storage object's MIME type) must be one the kind
//      accepts: a PNG/JPEG/GIF/WebP image, or `application/pdf`;
//   2. the recorded size is within the modality's cap (20 MiB for an image,
//      50 MiB for a PDF, the AI platform's own storage-input caps);
//   3. the STORED BYTES are read back (`IntakeInputInspector`): the leading
//      magic bytes must say the same thing as the MIME type (a text file
//      renamed to `.pdf` is refused), and a PDF's pages are counted against
//      `maxPdfPages` (default `INTAKE_PDF_MAX_PAGES`).
//
// Everything in this file is pure: no Nest, no Prisma, no I/O.
// =============================================================================

/** What kind of file an intake input is. */
export const INTAKE_INPUT_KINDS = ['image', 'pdf'] as const;
export type IntakeInputKind = (typeof INTAKE_INPUT_KINDS)[number];

/** What a kind accepts when it declares nothing: images only. */
export const DEFAULT_INTAKE_ACCEPTED_INPUTS: readonly IntakeInputKind[] = ['image'];

/** The one MIME type of a PDF input. */
export const PDF_MIME_TYPE = 'application/pdf';

/**
 * The page cap a PDF input gets when its kind declares no `maxPdfPages`.
 * A constant, not an environment variable or a system setting: it bounds the
 * cost of one AI request, the same way the 16-inputs-per-request cap does, and
 * a kind that needs another cap declares it in code.
 */
export const INTAKE_PDF_MAX_PAGES = 20;

/** Span attribute on attach and analyze: `image`, `pdf` or `mixed`. */
export const INTAKE_INPUT_KIND_SPAN_ATTRIBUTE = 'intake.input_kind';

/** Span attribute on analyze: pages sent (an image is one, a PDF its counted pages) (H4, #188). */
export const INTAKE_PAGE_COUNT_SPAN_ATTRIBUTE = 'intake.page_count';

/** The user-readable refusal when the resolved model cannot read a PDF. */
export const PDF_INPUT_UNSUPPORTED_MESSAGE =
  "Your AI model can't read PDFs; choose a model with file input or upload an image.";

/** How many leading bytes the magic-byte sniff needs (a PDF header may sit anywhere in the first 1024). */
export const INTAKE_SNIFF_BYTES = 1024;

/** The kind's accepted inputs, or the default. */
export function acceptedInputsOf(kind: { acceptedInputs?: readonly IntakeInputKind[] } | undefined): readonly IntakeInputKind[] {
  return kind?.acceptedInputs ?? DEFAULT_INTAKE_ACCEPTED_INPUTS;
}

/** The kind's PDF page cap, or the default. */
export function maxPdfPagesOf(kind: { maxPdfPages?: number } | undefined): number {
  return kind?.maxPdfPages ?? INTAKE_PDF_MAX_PAGES;
}

/** The input kind a declared MIME type names, or `null` for anything an intake never takes. */
export function declaredInputKind(mimeType: string | null | undefined): IntakeInputKind | null {
  if (!mimeType) return null;
  const normalised = normaliseMimeType(mimeType);
  if (mimeTypeMatches(normalised, AI_STORAGE_INPUT_IMAGE_MIME_TYPES)) return 'image';
  if (mimeTypeMatches(normalised, [PDF_MIME_TYPE])) return 'pdf';
  return null;
}

/** The size cap of an input kind (the AI platform's storage-input caps). */
export function inputMaxBytes(kind: IntakeInputKind): number {
  return kind === 'pdf' ? AI_STORAGE_INPUT_FILE_MAX_BYTES : AI_STORAGE_INPUT_IMAGE_MAX_BYTES;
}

/** The MIME types a kind accepting `accepted` takes, for `details.allowed`. */
export function allowedMimeTypes(accepted: readonly IntakeInputKind[]): string[] {
  return [
    ...(accepted.includes('image') ? AI_STORAGE_INPUT_IMAGE_MIME_TYPES : []),
    ...(accepted.includes('pdf') ? [PDF_MIME_TYPE] : []),
  ];
}

/** The refusal text for a type the kind does not accept. */
export function unsupportedTypeMessage(accepted: readonly IntakeInputKind[]): string {
  const images = 'PNG, JPEG, GIF and WebP images';
  if (accepted.includes('pdf') && accepted.includes('image')) return `Only ${images} or PDF files can be attached`;
  if (accepted.includes('pdf')) return 'Only PDF files can be attached';
  return `Only ${images} can be attached`;
}

/** `image`, `pdf`, `mixed`, or `null` for no inputs: the `intake.input_kind` span value. */
export function inputKindAttribute(kinds: Iterable<IntakeInputKind>): IntakeInputKind | 'mixed' | null {
  const seen = new Set(kinds);
  if (seen.size === 0) return null;
  if (seen.size > 1) return 'mixed';
  return [...seen][0];
}

/**
 * What the leading bytes say a file is: `image` for a PNG, JPEG, GIF or WebP
 * signature, `pdf` for a `%PDF-` header, `null` for anything else. The PDF
 * header may be preceded by up to 1024 bytes of junk, which every mainstream
 * reader tolerates, so the whole head is searched; an image signature must be
 * at offset 0.
 */
export function sniffInputKind(head: Buffer): IntakeInputKind | null {
  if (detectImageType(head)) return 'image';

  const window = head.subarray(0, INTAKE_SNIFF_BYTES);
  if (window.indexOf('%PDF-', 0, 'latin1') !== -1) return 'pdf';

  return null;
}

// -----------------------------------------------------------------------------
// PDF page counting
// -----------------------------------------------------------------------------
//
// WHY NO LIBRARY. A full parser (pdf.js, pdf-lib) is a large dependency for
// one number, and pdf-lib is unmaintained. The count only has to be good
// enough to bound the cost of an AI request, so this counts PAGE OBJECTS:
//
//   - every `/Type /Page` dictionary (never `/Pages`, the page-tree nodes) in
//     the file as stored, and
//   - the same inside each Flate-compressed object stream (`/Type /ObjStm`,
//     PDF 1.5+), where modern writers put most dictionaries; the streams are
//     inflated with the built-in zlib, under a total output budget.
//
// It errs on the side of MORE pages: an incremental update that rewrote a
// page leaves the old object in the file too, so such a file may be counted
// high and refused sooner, never later. A file where no page object can be
// found (an encrypted object stream, a damaged file, an unsupported filter)
// has no count (`null`), and the attach refuses it as unreadable: an unknown
// page count is never waved through to the model.
// -----------------------------------------------------------------------------

/** The most bytes all inflated object streams of one file may expand to. */
export const PDF_INFLATE_BUDGET_BYTES = 64 * 1024 * 1024;

/** A `/Type /Page` name: `/Page` followed by a PDF delimiter or whitespace (so never `/Pages`). */
const PAGE_OBJECT = /\/Type\s*\/Page(?![^\s()<>[\]{}/%])/g;

const OBJECT_STREAM = /\/Type\s*\/ObjStm(?![^\s()<>[\]{}/%])/g;

function countPageObjects(text: string): number {
  return text.match(PAGE_OBJECT)?.length ?? 0;
}

/** The raw bytes of the first `stream ... endstream` after `from`, or `null`. */
function streamAfter(bytes: Buffer, from: number): { data: Buffer; end: number } | null {
  const keyword = bytes.indexOf('stream', from, 'latin1');
  if (keyword === -1) return null;

  let start = keyword + 'stream'.length;
  if (bytes[start] === 0x0d) start += 1; // CR
  if (bytes[start] === 0x0a) start += 1; // LF

  const end = bytes.indexOf('endstream', start, 'latin1');
  if (end === -1) return null;

  return { data: bytes.subarray(start, end), end: end + 'endstream'.length };
}

/**
 * The number of pages of a PDF, or `null` when no page object can be found
 * (see the block above). `bytes` is the whole file, already bounded by the
 * caller's size cap.
 */
export function countPdfPages(bytes: Buffer): number | null {
  const text = bytes.toString('latin1');
  let pages = countPageObjects(text);
  let budget = PDF_INFLATE_BUDGET_BYTES;

  for (const match of text.matchAll(OBJECT_STREAM)) {
    const stream = streamAfter(bytes, match.index + match[0].length);
    if (!stream) continue;

    let inflated: Buffer;
    try {
      inflated = inflateSync(stream.data, { maxOutputLength: Math.max(1, budget) });
    } catch (error) {
      // Over the budget: a decompression bomb, or simply too much to count.
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return null;
      // Not Flate, encrypted or damaged: skip this stream.
      continue;
    }

    budget -= inflated.length;
    pages += countPageObjects(inflated.toString('latin1'));
  }

  return pages > 0 ? pages : null;
}
