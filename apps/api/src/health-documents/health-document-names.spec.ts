import {
  contentDispositionOf,
  DEFAULT_DOWNLOAD_NAME,
  downloadNameOf,
  effectiveDisposition,
  sanitizeDocumentName,
} from './health-document-names';

// =============================================================================
// Health document names (H6, #190): rename sanitising and Content-Disposition
// =============================================================================

describe('sanitizeDocumentName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeDocumentName('Lab report 2026-09.pdf')).toBe('Lab report 2026-09.pdf');
  });

  it('drops control characters and collapses whitespace', () => {
    expect(sanitizeDocumentName('  a\u0000b\r\nc\t\u007f d\u0085  ')).toBe('ab c d');
  });

  it('drops direction overrides that disguise an extension', () => {
    expect(sanitizeDocumentName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeDocumentName('a\u2066b\u2069c\u200Fd')).toBe('abcd');
  });

  it('turns path separators into underscores', () => {
    expect(sanitizeDocumentName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeDocumentName('C:\\Users\\me.pdf')).toBe('C:_Users_me.pdf');
  });

  it('drops lone surrogates and normalises to NFC', () => {
    expect(sanitizeDocumentName('a\uD800b')).toBe('ab');
    expect(sanitizeDocumentName('Cafe\u0301.pdf')).toBe('Café.pdf');
  });

  it('can leave nothing, which the download name replaces', () => {
    expect(sanitizeDocumentName('\u0000 \u202E')).toBe('');
    expect(downloadNameOf('\u0000 \u202E')).toBe(DEFAULT_DOWNLOAD_NAME);
  });
});

describe('contentDispositionOf', () => {
  it('writes an ASCII fallback and the RFC 5987 name', () => {
    expect(contentDispositionOf('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('encodes non-ASCII names exactly in filename* and replaces them in the fallback', () => {
    expect(contentDispositionOf('inline', 'análisis de sangre.pdf')).toBe(
      `inline; filename="an_lisis de sangre.pdf"; filename*=UTF-8''an%C3%A1lisis%20de%20sangre.pdf`,
    );
  });

  it('cannot be broken out of: quotes, backslashes, semicolons, CR/LF never reach the header raw', () => {
    const header = contentDispositionOf('inline', 'x".pdf"; filename=evil.html\r\nSet-Cookie: a=b\\');

    expect(header).not.toMatch(/[\r\n]/);
    const [, fallback] = header.match(/filename="([^"]*)"/)!;
    expect(fallback).not.toMatch(/["\\;]/);
    const [, encoded] = header.match(/filename\*=UTF-8''(.*)$/)!;
    expect(encoded).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]*$/);
    expect(header.match(/;/g)).toHaveLength(2);
  });

  it("percent-encodes the characters encodeURIComponent leaves but RFC 5987 forbids", () => {
    expect(contentDispositionOf('attachment', "it's (1)*.pdf")).toContain(
      `filename*=UTF-8''it%27s%20%281%29%2A.pdf`,
    );
  });

  it('never writes an empty name', () => {
    expect(contentDispositionOf('attachment', '\u0000')).toBe(
      `attachment; filename="document"; filename*=UTF-8''document`,
    );
  });
});

describe('effectiveDisposition', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png', 'IMAGE/WEBP'])('allows inline for %s', (type) => {
    expect(effectiveDisposition('inline', type)).toBe('inline');
  });

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream'])('forces attachment for %s', (type) => {
    expect(effectiveDisposition('inline', type)).toBe('attachment');
  });

  it('honours an attachment request for any type', () => {
    expect(effectiveDisposition('attachment', 'application/pdf')).toBe('attachment');
  });
});
