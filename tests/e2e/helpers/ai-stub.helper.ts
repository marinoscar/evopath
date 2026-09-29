import type { Page } from '@playwright/test';

/**
 * Answer the two "is AI on?" reads with fixed bodies, client side.
 *
 * Whether AI is on is deployment-wide state that an operator (or the scan
 * spec, which really switches it on) may have changed, so specs that assert
 * the AI-off or no-vision-model copy stub the reads instead of mutating that
 * state. Everything else stays the real API. Same approach as
 * `health-photo-read.spec.ts`.
 */
export async function stubAiState(
  page: Page,
  state: { enabled: boolean; models?: unknown[] },
): Promise<void> {
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled: state.enabled, keyPolicy: 'byok', providers: [] } }),
    }),
  );
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.models ?? [] }) }),
  );
}
