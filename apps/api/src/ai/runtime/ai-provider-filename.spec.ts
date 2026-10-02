import { providerFileName } from './ai-provider-filename';

describe('providerFileName (#301)', () => {
  it('lower-cases an upper-case extension that matches the MIME type', () => {
    expect(providerFileName('Result Trends - PANEL - Oct 1 2026.PDF', 'application/pdf')).toBe(
      'Result Trends - PANEL - Oct 1 2026.pdf'
    );
  });

  it('appends the canonical extension when the name has none', () => {
    expect(providerFileName('report', 'application/pdf')).toBe('report.pdf');
  });

  it('appends the canonical extension when the name has a mismatched one', () => {
    expect(providerFileName('scan.v2', 'application/pdf')).toBe('scan.v2.pdf');
    expect(providerFileName('photo.png', 'image/jpeg')).toBe('photo.png.jpg');
  });

  it('strips any directory path, POSIX or Windows', () => {
    expect(providerFileName('/tmp/uploads/labs.pdf', 'application/pdf')).toBe('labs.pdf');
    expect(providerFileName('C:\\Users\\me\\Labs.Pdf', 'application/pdf')).toBe('Labs.pdf');
  });

  it('keeps jpeg and jpg for a JPEG', () => {
    expect(providerFileName('IMG_0001.JPEG', 'image/jpeg')).toBe('IMG_0001.jpeg');
    expect(providerFileName('IMG_0002.jpg', 'image/jpeg')).toBe('IMG_0002.jpg');
  });

  it('maps the common MIME types to their canonical extension', () => {
    expect(providerFileName('a', 'image/png')).toBe('a.png');
    expect(providerFileName('a', 'image/gif')).toBe('a.gif');
    expect(providerFileName('a', 'image/webp')).toBe('a.webp');
    expect(providerFileName('a', 'text/plain')).toBe('a.txt');
    expect(providerFileName('a', 'text/csv; charset=utf-8')).toBe('a.csv');
    expect(providerFileName('a', 'application/json')).toBe('a.json');
    expect(providerFileName('memo.MP3', 'audio/mpeg')).toBe('memo.mp3');
  });

  it('keeps the lower-cased extension of a MIME type with no canonical extension', () => {
    expect(providerFileName('Notes.MD', 'text/markdown')).toBe('Notes.md');
    expect(providerFileName('blob', 'application/octet-stream')).toBe('blob');
  });

  it('falls back to "file" for an empty, blank or missing name', () => {
    expect(providerFileName(undefined, 'application/pdf')).toBe('file.pdf');
    expect(providerFileName('   ', 'application/pdf')).toBe('file.pdf');
    expect(providerFileName('dir/', 'text/markdown')).toBe('file');
  });

  it('trims whitespace and trailing dots', () => {
    expect(providerFileName('  report.  ', 'application/pdf')).toBe('report.pdf');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(providerFileName('.env', 'text/plain')).toBe('.env.txt');
  });
});
