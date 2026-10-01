import { deflateSync } from 'node:zlib';

// =============================================================================
// TEST-ONLY PDF builders (H2, #186): small, structurally valid PDFs with a
// known page count, for the magic-byte sniff and the page counter.
// =============================================================================

/** A 1x1 PNG's leading bytes: enough for the magic-byte sniff. */
export const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

/** A JPEG's leading bytes: enough for the magic-byte sniff. */
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test-bytes')]);

function assemble(objects: string[]): Buffer {
  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
}

/** A PDF with `pages` pages whose dictionaries are stored in the clear (PDF 1.4 style). */
export function plainPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ];
  return assemble(objects);
}

/**
 * A PDF with `pages` pages whose page dictionaries sit in a Flate-compressed
 * object stream (`/Type /ObjStm`, PDF 1.5+), so none is visible in the clear.
 */
export function objectStreamPdf(pages: number): Buffer {
  const first = 3;
  const dicts = Array.from({ length: pages }, () => '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>');
  let offset = 0;
  const header = dicts
    .map((dict, i) => {
      const entry = `${first + i} ${offset}`;
      offset += dict.length + 1;
      return entry;
    })
    .join(' ');
  const content = `${header}\n${dicts.join('\n')}\n`;
  const data = deflateSync(Buffer.from(content, 'latin1'));
  const kids = Array.from({ length: pages }, (_, i) => `${first + i} 0 R`).join(' ');

  const head = assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
  ]);
  const stream = Buffer.concat([
    Buffer.from(
      `${first + pages} 0 obj\n<< /Type /ObjStm /N ${pages} /First ${header.length + 1} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
      'latin1',
    ),
    data,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);

  // Appended after the classic xref: the counter does not need a valid xref.
  return Buffer.concat([head, stream]);
}
