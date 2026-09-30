import type { Page } from '@playwright/test';

const PHOTO_FEATURES = [
  ['gym_scan', 'Gym equipment scan'],
  ['workout_prefill', 'Workout prefill from a photo'],
  ['body_metric_reading', 'Body metric photo reading'],
] as const;

/**
 * `GET /api/ai/features` (#173): every photo feature resolved for the caller.
 * `no_key` is "AI is on but this caller has no key that reaches a model" (the
 * "Add your own AI key" notice); `ready` is the administrator's `openai` /
 * `gpt-5-mini` on the caller's own key.
 */
function photoFeatures(state: 'ready' | 'no_key') {
  return {
    features: PHOTO_FEATURES.map(([featureId, label]) => ({
      featureId,
      label,
      group: 'photo',
      state,
      ...(state === 'ready'
        ? {
            source: 'admin_feature',
            model: { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', keySource: 'user' },
          }
        : {}),
      needs: ['vision_input', 'structured_output'],
      inputModalities: ['image'],
      requestedEffort: null,
      effectiveEffort: null,
      fix: state === 'ready' ? null : 'keys',
    })),
  };
}

/**
 * Answer the "is AI on?" and "which model would a photo feature use?" reads
 * with fixed bodies, client side.
 *
 * Whether AI is on is deployment-wide state that an operator (or the scan
 * spec, which really switches it on) may have changed, so specs that assert
 * the AI-off or no-usable-model copy stub the reads instead of mutating that
 * state. Everything else stays the real API. Models are the administrator's
 * choice (#173): the browser reads `/api/ai/features`, never `/api/ai/models`.
 * `features` defaults to `no_key`.
 */
export async function stubAiState(
  page: Page,
  state: { enabled: boolean; features?: 'ready' | 'no_key' },
): Promise<void> {
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled: state.enabled, keyPolicy: 'byok', providers: [] } }),
    }),
  );
  await page.route('**/api/ai/features', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: photoFeatures(state.features ?? 'no_key') }) }),
  );
}
