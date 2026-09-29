import type { Page, Route } from '@playwright/test';
import { FIXED_NOW } from './health';

/**
 * Fixture API for "Read from photo" on the Health page — issue #64 (E2.6).
 *
 * Layered ON TOP of `mockHealthApi()` (call this after it: Playwright tries
 * the most recently registered route first, and every path not handled here
 * falls back to the health fixtures). It answers:
 *
 * - `/api/ai/config` (AI on) and `/api/ai/models` (one vision model on the
 *   user's own key), read through the harness's `?ai=on` provider and by
 *   `useVisionAvailability`;
 * - `/api/intakes` (the resume list) and `/api/intakes/:id` with ONE intake
 *   in the requested state: `draft` (the photo step) or `ready` (a
 *   blood-pressure cuff reading under review);
 * - `/api/storage/objects/:id/download` with a data-URI "photo", so a
 *   thumbnail never reaches the network;
 * - `/api/measurements` (History) with two entries read from a photo (one
 *   the user corrected) above a manual one.
 *
 * Timestamps derive from {@link FIXED_NOW}, as in `support/health.ts`.
 */

export type PhotoReadScenario = 'draft' | 'review';

/** The permissions the photo-read control needs, besides AI being on (`hooks/useCanReadFromPhoto.ts`). */
export const PHOTO_READ_PERMS = [
  'health_data:read',
  'health_data:write',
  'storage:read',
  'storage:write',
  'intakes:read',
  'intakes:write',
  'ai:use',
  'user_settings:read',
  'user_settings:write',
];

const iso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

/** A flat grey square: deterministic pixels, no network. */
const PHOTO_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#8a8f98"/></svg>');

const AI_CONFIG = {
  enabled: true,
  keyPolicy: 'byok_with_org_fallback',
  allowBackgroundRuns: true,
  providers: [{ id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: true, supportsPreviousResponseId: true }],
};

const MODELS = [
  {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    capabilities: {
      capabilities: ['responses', 'vision_input', 'structured_output'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    keySource: 'user',
  },
];

function item(
  id: string,
  sortOrder: number,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'reading',
    origin: 'ai',
    status: 'pending',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: ['obj-cuff'],
    userVerified: false,
    value,
    originalAiValue: null,
    sortOrder,
    ...extra,
  };
}

function intake(scenario: PhotoReadScenario) {
  const ready = scenario === 'review';
  return {
    id: 'intake-visual-1',
    kind: 'body_metric_reading',
    status: ready ? 'ready' : 'draft',
    subjectType: null,
    subjectId: null,
    context: {},
    provider: ready ? 'openai' : null,
    modelId: ready ? 'gpt-5-mini' : null,
    jobId: ready ? 'job-visual-1' : null,
    errorCode: null,
    errorMessage: null,
    resultMeta: ready ? { promptVersion: 1, deviceKind: 'bp_cuff', unreadable: false, readingsFlagged: 0 } : null,
    createdAt: iso(10 * 60 * 1000),
    updatedAt: iso(9 * 60 * 1000),
    completedAt: ready ? iso(9 * 60 * 1000) : null,
    photos: ready ? [{ id: 'photo-1', storageObjectId: 'obj-cuff', name: 'cuff.jpg', sortOrder: 0 }] : [],
    items: ready
      ? [
          item('item-sys', 0, { metricKey: 'bp_systolic', value: 128, unit: 'mmHg', method: 'bp_cuff' }, {
            status: 'accepted',
            userVerified: true,
          }),
          item('item-dia', 1, { metricKey: 'bp_diastolic', value: 84, unit: 'mmHg', method: 'bp_cuff' }),
          item('item-hr', 2, { metricKey: 'resting_hr', value: 72, unit: 'bpm', method: 'bp_cuff' }, {
            confidence: 'medium',
            uncertain: true,
            uncertaintyNote: 'Pulse from a blood-pressure cuff may not be a resting rate',
          }),
        ]
      : [],
  };
}

let n = 0;
function row(metricKey: string, value: number, unit: string, msAgo: number, entry: string, extra: Record<string, unknown>) {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-9${String(n).padStart(11, '0')}`,
    entryId: `00000000-0000-4000-9000-9${entry.padStart(11, '0')}`,
    metricKey,
    value,
    unit,
    measuredAt: iso(msAgo),
    method: 'unspecified',
    origin: 'manual',
    notes: null,
    sourceRef: null,
    revision: 1,
    edited: false,
    ...extra,
  };
}

function aiRef(intakeId: string, aiDraft: Record<string, unknown>, userEdited: boolean) {
  return {
    kind: 'photo_intake',
    intakeId,
    draftItemId: `${intakeId}-item`,
    storageObjectIds: ['obj-scale'],
    aiDraft,
    confidence: 'high',
    userEdited,
  };
}

/** History: a corrected scale reading, an unedited cuff pair, then a manual weight. */
function history() {
  const rows = [
    // The AI read 208.4 lb; the user corrected it to 209.4 lb (94.9863 kg).
    row('weight', 94.9863, 'kg', 2 * HOUR, '1', {
      origin: 'ai',
      method: 'scale',
      sourceRef: aiRef('i-scale', { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' }, true),
    }),
    row('bp_systolic', 128, 'mmHg', 26 * HOUR, '2', {
      origin: 'ai',
      method: 'bp_cuff',
      sourceRef: aiRef('i-cuff', { metricKey: 'bp_systolic', value: 128, unit: 'mmHg', method: 'bp_cuff' }, false),
    }),
    row('bp_diastolic', 84, 'mmHg', 26 * HOUR, '2', {
      origin: 'ai',
      method: 'bp_cuff',
      sourceRef: aiRef('i-cuff', { metricKey: 'bp_diastolic', value: 84, unit: 'mmHg', method: 'bp_cuff' }, false),
    }),
    row('weight', 94.7595, 'kg', 3 * 24 * HOUR, '3', { method: 'smart_scale' }),
  ];
  return { items: rows, total: rows.length, page: 1, pageSize: 20, totalPages: 1 };
}

function answer(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
}

/** Answer the AI, intake and photo endpoints for `scenario`. Call after `mockHealthApi()`, before `page.goto()`. */
export async function mockPhotoReadApi(page: Page, scenario: PhotoReadScenario): Promise<void> {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/ai/config') return answer(route, AI_CONFIG);
    if (path === '/api/ai/models') return answer(route, MODELS);
    if (path === '/api/measurements') return answer(route, history());
    if (path === '/api/intakes' && route.request().method() === 'GET') {
      const { photos, items, ...summary } = intake(scenario);
      return answer(route, [{ ...summary, photoCount: photos.length, itemCount: items.length }]);
    }
    if (path === '/api/intakes/intake-visual-1') return answer(route, intake(scenario));
    const download = /^\/api\/storage\/objects\/([^/]+)\/download$/.exec(path);
    if (download) return answer(route, { url: PHOTO_URL, expiresIn: 300 });
    return route.fallback();
  });
}
