/**
 * The opt-in AI health summary (H8, #192): `GET /api/ai/training/health-summary`
 * and the consent/refresh answers. The default is off, a runnable model, data
 * present and no summary yet; `mockHealthSummaryView` takes overrides.
 */
import type { HealthSummaryText, HealthSummaryView } from '../../../services/healthSummary';

export const mockHealthSummaryShared = [
  'Lab results: the latest and previous value of each analyte, with its flag and reference range',
  'Blood pressure and resting heart rate: latest readings and 30- and 90-day averages',
  'Body measurements: weight trend, body fat and waist',
  'Check-in scores: 28-day averages and runs of low days',
  'Your age in whole years and sex at birth',
];

export const mockHealthSummaryNeverShared = [
  'Documents, photos and file names',
  'Notes and any other free text',
  'Lab and test names as printed, and the lab that issued them',
  'Your name, e-mail and date of birth',
];

export const mockHealthSummaryText: HealthSummaryText = {
  version: 2,
  narrative:
    'Your recent check-ins show several low-energy days in a row. Blood pressure has been outside the reference range; discuss it with a clinician.',
  trainingConsiderations: [
    { text: 'Prefer moderate intensity until blood pressure is reviewed.', severity: 'caution', conservative: true },
    { text: 'Plan an easier week after several low-energy days.', severity: 'info', conservative: false },
  ],
  dataAsOf: '2026-09-28',
  createdAt: '2026-09-29T10:15:00.000Z',
  provider: 'openai',
  model: 'frontier-1',
};

export function mockHealthSummaryView(overrides: Partial<HealthSummaryView> = {}): HealthSummaryView {
  return {
    enabled: false,
    consentedAt: null,
    sharing: {
      shared: [...mockHealthSummaryShared],
      neverShared: [...mockHealthSummaryNeverShared],
      modelState: 'ready',
      processor: { provider: 'openai', modelId: 'frontier-1', displayName: 'Frontier One' },
    },
    summary: null,
    lastAttempt: null,
    hasData: true,
    stale: false,
    pending: false,
    ...overrides,
  };
}

/** Consent on with a ready summary. */
export function mockHealthSummaryEnabled(overrides: Partial<HealthSummaryView> = {}): HealthSummaryView {
  return mockHealthSummaryView({
    enabled: true,
    consentedAt: '2026-09-29T10:00:00.000Z',
    summary: mockHealthSummaryText,
    lastAttempt: { version: 2, status: 'ready', errorCode: null, createdAt: '2026-09-29T10:15:00.000Z' },
    ...overrides,
  });
}
