/**
 * Health profile fixtures (issue #47, E2.1), shaped exactly as
 * `GET`/`PUT /api/health-profile` answer inside the `{ data }` envelope.
 */
import type { HealthProfile } from '../../../services/health';

/** A user with no row yet: all nulls, `metric`, `version: 0`. */
export const mockHealthProfileEmpty: HealthProfile = {
  dateOfBirth: null,
  sexAtBirth: null,
  heightMm: null,
  unitSystem: 'metric',
  timeZone: null,
  bio: null,
  version: 0,
  updatedAt: null,
};

/** A saved imperial profile: 5 ft 10 in is exactly 1778 mm. */
export const mockHealthProfileSaved: HealthProfile = {
  dateOfBirth: '1990-02-28',
  sexAtBirth: 'female',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'America/New_York',
  bio: 'Training for a half marathon.',
  version: 3,
  updatedAt: '2026-09-01T10:00:00.000Z',
};
