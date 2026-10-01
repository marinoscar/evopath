import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The canned model answers of H4 (#188), as the provider would return them.
 *
 * `lipid-glucose-panel`: a one-document report collected 2026-09-15 by "Acme
 * Clinical Laboratories" with seven results: four lipids in mg/dL (resolved
 * from printed names and aliases), `Lipoprotein (a)` (NOT in the catalog: the
 * unmatched row), fasting glucose printed in mmol/L (converted to mg/dL) and
 * HbA1c in %.
 */
export const LAB_REPORT_FIXTURES = ['lipid-glucose-panel'] as const;
export type LabReportFixture = (typeof LAB_REPORT_FIXTURES)[number];

/** The raw JSON text of a fixture (what a provider's `outputText` would carry). */
export function labReportFixtureText(name: LabReportFixture): string {
  return readFileSync(join(__dirname, `${name}.model-output.json`), 'utf8');
}

/** A fixture parsed as plain JSON (not yet validated). */
export function labReportFixture(name: LabReportFixture): any {
  return JSON.parse(labReportFixtureText(name));
}
