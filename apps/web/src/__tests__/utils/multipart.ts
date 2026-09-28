/**
 * Read one file part out of a multipart request an MSW handler received.
 *
 * `request.formData()` is not usable for this: on Node 24 undici re-parses the
 * body and asserts every entry is one of *its own* `File`s, which a part built
 * from jsdom's `File` is not, so the handler throws and the upload never
 * answers (it passes on Node 22, which is why this only failed in CI). Reading
 * the raw body and picking the part's headers out of it works on both.
 */
export interface MultipartFilePart {
  name: string;
  filename: string;
  type: string;
}

export async function readMultipartFile(request: Request, field = 'file'): Promise<MultipartFilePart> {
  const body = await request.text();
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const disposition = new RegExp(
    `Content-Disposition: form-data; name="${escaped}"(?:; filename="([^"]*)")?\\r?\\n(?:Content-Type: ([^\\r\\n]+))?`,
    'i',
  ).exec(body);
  if (!disposition) throw new Error(`multipart body has no "${field}" part`);
  return { name: field, filename: disposition[1] ?? '', type: (disposition[2] ?? '').trim() };
}
