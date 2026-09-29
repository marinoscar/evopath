import type { Page } from '@playwright/test';

/**
 * Fixture API for the gyms surface as the Today "Your gym" card reads it
 * (E3.3): `GET /api/gyms`, the `GymSummary[]` list.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it, so without
 * this the card would render whichever of its loading skeleton, error or
 * empty state the fetch happened to land in. This answers with one default
 * gym, "Home Gym", holding four pieces of equipment, so the card renders the
 * same name and count on every run. The approach of `support/health.ts`:
 * `page.route()`, anything else falls through to the harness's Vite server.
 *
 * `GYM_EQUIPMENT_COUNT` is what the card prints ("4 pieces of equipment").
 */

export const GYM_NAME = 'Home Gym';
export const GYM_EQUIPMENT_COUNT = 4;

const GYMS = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    name: GYM_NAME,
    type: 'home',
    description: 'Garage setup',
    notes: null,
    latitude: null,
    longitude: null,
    isDefault: true,
    isTemporary: false,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    equipmentCount: GYM_EQUIPMENT_COUNT,
    photoCount: 0,
    coverPhotoId: null,
    coverStorageObjectId: null,
  },
];

/** Answer `GET /api/gyms` with the default gym. Call before `page.goto()`. */
export async function mockGymsApi(page: Page): Promise<void> {
  await page.route('**/api/gyms**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/gyms' && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: GYMS }) });
    }
    return route.fallback();
  });
}
