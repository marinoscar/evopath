// =============================================================================
// CSV cell helpers shared by every file export (telemetry #535, health #191)
// =============================================================================
//
// RFC 4180: fields joined by `,`, records by CRLF, a field holding `"`, `,`,
// CR or LF is quoted and its quotes doubled. Files start with a UTF-8 BOM so
// Excel detects the encoding.
//
// FORMULA INJECTION. A text cell a spreadsheet would read as a formula
// (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'`. Exported text can be
// user- or attacker-controlled (a note, a file name, a log line), and CSV
// injection is the classic way to turn one into code on the reader's
// machine. Callers leave numeric columns alone, so `-5` stays `-5`.
// =============================================================================

/** The UTF-8 byte order mark, as the one character it encodes. */
export const UTF8_BOM = '﻿';

/** What a spreadsheet treats as the start of a formula. */
export const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One field, quoted when RFC 4180 requires it. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `text` prefixed with `'` when a spreadsheet would read it as a formula. */
export function neutralizeFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/** One CSV record (no line ending). */
export function csvRecord(fields: readonly string[]): string {
  return fields.join(',');
}
