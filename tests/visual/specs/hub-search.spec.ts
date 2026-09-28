import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * `SettingsHub`'s client-side "Search settings" filter — a plain `useState`,
 * not a URL param the harness can pre-seed (`?query=` is not read anywhere),
 * so both specs drive the real search input via Playwright's `fill()` rather
 * than adding a harness-only shortcut. That is closer to real usage and
 * exercises the actual `onChange` handler in `SettingsHub.tsx`.
 *
 * The hub has no network fetch, so both screenshots are safe as full-page
 * captures.
 *
 * ⚠ BOTH CAPTURES ARE `fullPage`, WHICH INCLUDES THE CONSOLE RAIL. That makes
 * these two baselines sensitive to something they do not test: ADDING AN ADMIN
 * SETTINGS CARD moves them, because the rail grows a row, even though neither
 * spec's own subject — the search filter — has changed at all.
 *
 * This was got wrong once, in exactly the way that matters: adding the About
 * card (#401) was predicted to leave `hub-search` alone, on the reasonable
 * grounds that its filter matches "Maintenance" and a nonsense string, so the
 * new card is not in either result. Both baselines moved anyway, by the same
 * 222 pixels as `console-rail` — the rail, not the results.
 *
 * So when you add a card, expect SIX baselines to move, not four: the three
 * `admin-hub` widths, `console-rail`, and both of these. A regeneration that
 * touches only four has missed something.
 */

const VIEWPORT = { width: 1440, height: 900 };

test('Hub search: filtered result', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(harnessUrl({ route: '/admin/settings' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const search = page.getByLabel('Search settings');
  await expect(search).toBeVisible();
  await search.fill('Maintenance');

  const main = page.locator('main');
  await expect(main.getByText('Maintenance')).toBeVisible();
  // The miss for every other card confirms the filter actually narrowed the
  // set rather than the assertion above being a false positive against an
  // unfiltered grid.
  await expect(main.getByText('Notifications', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Users & Allowlist')).toHaveCount(0);

  await expect(page).toHaveScreenshot('hub-search-filtered-maintenance.png', {
    fullPage: true,
  });
});

test('Hub search: "No settings match" empty state', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(harnessUrl({ route: '/admin/settings' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const search = page.getByLabel('Search settings');
  await expect(search).toBeVisible();
  await search.fill('zzz-nonsense-query-zzz');

  // Exact copy from `SettingsHub.tsx`: `No settings match "{trimmedQuery}".`
  // (curly quotes, verified by reading the component past line 150).
  await expect(
    page.getByText('No settings match “zzz-nonsense-query-zzz”.'),
  ).toBeVisible();

  await expect(page).toHaveScreenshot('hub-search-empty-state.png', {
    fullPage: true,
  });
});
