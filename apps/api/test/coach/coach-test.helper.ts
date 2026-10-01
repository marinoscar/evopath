// =============================================================================
// Shared fixtures for the AI Coach HTTP suites (E7.2, #242)
// =============================================================================

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { SystemCoachValue } from '../../src/common/schemas/settings.schema';
import type { TestContext } from '../helpers/test-app.helper';

/** A date of birth that makes the user an adult / a minor on any date this suite runs. */
export const ADULT_DOB = '1990-05-05';
export const MINOR_DOB = `${new Date().getUTCFullYear() - 15}-01-01`;

/**
 * Make the mocked `system_settings` row stateful, holding `coach` (defaults
 * plus `overrides`). A PATCH through `SystemSettingsService` writes back
 * into it, so a later read sees the change. Returns a setter for later
 * changes.
 */
export function useSystemCoachPolicy(
  context: TestContext,
  overrides: Partial<SystemCoachValue> = {},
): (next: Partial<SystemCoachValue>) => void {
  const prisma = context.prismaMock as any;
  let row = {
    id: 'system-settings-1',
    key: 'default',
    value: { coach: { ...DEFAULT_SYSTEM_SETTINGS.coach, ...overrides } } as Record<string, any>,
    version: 1,
    updatedByUserId: null,
    updatedByUser: null,
    updatedAt: new Date(),
    createdAt: new Date(),
  };

  prisma.systemSettings.findUnique.mockImplementation(async () => row);
  prisma.systemSettings.update.mockImplementation(async ({ data }: any) => {
    row = { ...row, value: data.value ?? row.value, version: row.version + 1, updatedAt: new Date() };
    return row;
  });
  prisma.systemSettings.upsert.mockImplementation(async () => row);
  prisma.systemSettings.create.mockImplementation(async () => row);

  return (next) => {
    row = { ...row, value: { ...row.value, coach: { ...row.value.coach, ...next } } };
  };
}

/** The caller's health profile carries this date of birth (`YYYY-MM-DD`), or none. */
export function useDateOfBirth(context: TestContext, dateOfBirth: string | null): void {
  const prisma = context.prismaMock as any;
  prisma.healthProfile.findUnique.mockImplementation(async ({ where }: any) => ({
    id: `hp-${where.userId}`,
    userId: where.userId,
    dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null,
    sexAtBirth: null,
    heightMm: null,
    unitSystem: 'metric',
    timeZone: null,
    bio: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

/** The body that selects Sarge L3 with profanity on. */
export const SARGE_L3_PROFANE = { personaId: 'drill_sergeant', intensity: 3, profanity: true } as const;
