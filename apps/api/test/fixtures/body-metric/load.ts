import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The canned model answers of E2.6 (#64), as the provider would return them,
 * plus `smart-scale-report`: a smart-scale PDF report read as one input (H2, #186).
 */
export const BODY_METRIC_FIXTURES = ['scale-display', 'bp-cuff', 'unreadable', 'out-of-range', 'smart-scale-report'] as const;
export type BodyMetricFixture = (typeof BODY_METRIC_FIXTURES)[number];

/** The raw JSON text of a fixture (what a provider's `outputText` would carry). */
export function bodyMetricFixtureText(name: BodyMetricFixture): string {
  return readFileSync(join(__dirname, `${name}.model-output.json`), 'utf8');
}

/** A fixture parsed as plain JSON (not yet validated). */
export function bodyMetricFixture(name: BodyMetricFixture): any {
  return JSON.parse(bodyMetricFixtureText(name));
}
