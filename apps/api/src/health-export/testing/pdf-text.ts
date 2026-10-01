// =============================================================================
// Text out of an uncompressed pdfkit PDF, for tests (H7, #191)
// =============================================================================
//
// pdfkit writes text with the standard fonts as `[<hex> kern <hex> ...] TJ`
// operators. With `compress: false` those operators sit in the file as
// plain text, so decoding every TJ array's hex strings (WinAnsi, read as
// Latin-1) recovers what each line says. Text-based, never pixel-based.
// =============================================================================

/** Each text run of `pdf`, in drawing order. */
export function pdfTextRuns(pdf: Buffer): string[] {
  const source = pdf.toString('latin1');
  const runs: string[] = [];

  for (const match of source.matchAll(/\[((?:<[0-9a-fA-F]*>|[\s\d.-])*)\]\s*TJ/g)) {
    let text = '';
    for (const hex of match[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
      text += Buffer.from(hex[1], 'hex').toString('latin1');
    }
    runs.push(text);
  }

  return runs;
}

/** Every text run joined by newlines. */
export function pdfText(pdf: Buffer): string {
  return pdfTextRuns(pdf).join('\n');
}

/** How many pages the document declares (`/Type /Page` objects). */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}
