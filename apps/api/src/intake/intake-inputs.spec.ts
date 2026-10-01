import { deflateSync } from 'node:zlib';

import {
  acceptedInputsOf,
  allowedMimeTypes,
  countPdfPages,
  declaredInputKind,
  DEFAULT_INTAKE_ACCEPTED_INPUTS,
  INTAKE_PDF_MAX_PAGES,
  inputKindAttribute,
  inputMaxBytes,
  maxPdfPagesOf,
  PDF_INFLATE_BUDGET_BYTES,
  sniffInputKind,
  unsupportedTypeMessage,
} from './intake-inputs';
import { JPEG_BYTES, objectStreamPdf, plainPdf, PNG_BYTES } from './testing/pdf-bytes';

// =============================================================================
// Intake inputs (H2, #186): declarations, the magic-byte sniff, page counting
// =============================================================================

describe('intake inputs', () => {
  describe('declarations', () => {
    it('a kind that declares nothing accepts images only, with the default page cap', () => {
      expect(DEFAULT_INTAKE_ACCEPTED_INPUTS).toEqual(['image']);
      expect(acceptedInputsOf({})).toEqual(['image']);
      expect(acceptedInputsOf(undefined)).toEqual(['image']);
      expect(acceptedInputsOf({ acceptedInputs: ['image', 'pdf'] })).toEqual(['image', 'pdf']);
      expect(INTAKE_PDF_MAX_PAGES).toBe(20);
      expect(maxPdfPagesOf({})).toBe(20);
      expect(maxPdfPagesOf({ maxPdfPages: 5 })).toBe(5);
    });

    it.each([
      ['image/png', 'image'],
      ['image/jpeg', 'image'],
      ['IMAGE/WEBP; q=1', 'image'],
      ['image/gif', 'image'],
      ['application/pdf', 'pdf'],
      ['Application/PDF', 'pdf'],
      ['image/svg+xml', null],
      ['text/plain', null],
      ['application/octet-stream', null],
      ['', null],
    ])('declaredInputKind(%j) is %j', (mimeType, expected) => {
      expect(declaredInputKind(mimeType)).toBe(expected);
    });

    it('caps an image at 20 MiB and a PDF at 50 MiB', () => {
      expect(inputMaxBytes('image')).toBe(20 * 1024 * 1024);
      expect(inputMaxBytes('pdf')).toBe(50 * 1024 * 1024);
    });

    it('names the allowed types and the refusal per declaration', () => {
      expect(allowedMimeTypes(['image'])).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      expect(allowedMimeTypes(['image', 'pdf'])).toContain('application/pdf');
      expect(unsupportedTypeMessage(['image'])).toBe('Only PNG, JPEG, GIF and WebP images can be attached');
      expect(unsupportedTypeMessage(['image', 'pdf'])).toBe('Only PNG, JPEG, GIF and WebP images or PDF files can be attached');
    });

    it('the span value is image, pdf or mixed', () => {
      expect(inputKindAttribute(['image', 'image'])).toBe('image');
      expect(inputKindAttribute(['pdf'])).toBe('pdf');
      expect(inputKindAttribute(['pdf', 'image'])).toBe('mixed');
      expect(inputKindAttribute([])).toBeNull();
    });
  });

  describe('sniffInputKind (magic bytes)', () => {
    it('recognises images by signature and a PDF by its %PDF- header', () => {
      expect(sniffInputKind(PNG_BYTES)).toBe('image');
      expect(sniffInputKind(JPEG_BYTES)).toBe('image');
      expect(sniffInputKind(plainPdf(1))).toBe('pdf');
    });

    it('tolerates junk before the PDF header within the first 1024 bytes, not after', () => {
      expect(sniffInputKind(Buffer.concat([Buffer.alloc(100, 0x20), plainPdf(1)]))).toBe('pdf');
      expect(sniffInputKind(Buffer.concat([Buffer.alloc(1024, 0x20), plainPdf(1)]))).toBeNull();
    });

    it('refuses anything else: text renamed to .pdf, HTML, SVG, an empty file', () => {
      expect(sniffInputKind(Buffer.from('Just some notes, saved as notes.pdf'))).toBeNull();
      expect(sniffInputKind(Buffer.from('<html><body>%PDF</body></html>'))).toBeNull();
      expect(sniffInputKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
      expect(sniffInputKind(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('countPdfPages', () => {
    it.each([1, 3, 20, 21])('counts %i page(s) stored in the clear, never the /Pages tree node', (pages) => {
      expect(countPdfPages(plainPdf(pages))).toBe(pages);
    });

    it.each([1, 7, 25])('counts %i page(s) inside a compressed object stream', (pages) => {
      const bytes = objectStreamPdf(pages);

      // No page dictionary is visible in the clear.
      expect(bytes.toString('latin1')).not.toMatch(/\/Type\s*\/Page[^s]/);
      expect(countPdfPages(bytes)).toBe(pages);
    });

    it('answers null when no page can be found (damaged, or an unreadable object stream)', () => {
      expect(countPdfPages(Buffer.from('%PDF-1.7\n% nothing here\n%%EOF'))).toBeNull();

      const garbled = Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\nnot-deflate-data\nendstream\nendobj\n',
        'latin1',
      );
      expect(countPdfPages(garbled)).toBeNull();
    });

    it('answers null for an object stream that inflates past the budget (a decompression bomb)', () => {
      const bomb = deflateSync(Buffer.alloc(PDF_INFLATE_BUDGET_BYTES + 1024, 0x20));
      const bytes = Buffer.concat([
        Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\n', 'latin1'),
        bomb,
        Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n', 'latin1'),
      ]);

      expect(countPdfPages(bytes)).toBeNull();
    });
  });
});
