import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';

import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import {
  telemetryConfigResponseSchema,
  UpdateTelemetryConfigDto,
  updateTelemetryConfigSchema,
} from './telemetry-config.dto';

// =============================================================================
// PUT /api/admin/telemetry/config — the `instanceId` field (issue #565)
// =============================================================================
//
// Run through the same global `ZodValidationPipe` `app.module.ts` installs, so
// "rejected" here means what a client sees: a 400. `instanceId` is the one
// OPTIONAL field of an otherwise full-replace body (see the DTO header).
// =============================================================================

const BODY = structuredClone(DEFAULT_SYSTEM_SETTINGS.telemetry);

function validate(body: unknown): unknown {
  return new ZodValidationPipe().transform(body, { type: 'body', metatype: UpdateTelemetryConfigDto });
}

describe('UpdateTelemetryConfigDto (PUT /api/admin/telemetry/config)', () => {
  it.each(['prod-eu', 'my-app', 'a', 'x.y_z-1', 'a'.repeat(63)])('accepts the instanceId %p', (instanceId) => {
    expect(validate({ ...BODY, instanceId })).toMatchObject({ instanceId });
  });

  it('accepts null (back to the APP_SLUG default)', () => {
    expect(validate({ ...BODY, instanceId: null })).toMatchObject({ instanceId: null });
  });

  it('accepts a body without instanceId (a client that predates the field), leaving it absent', () => {
    const { instanceId: _omitted, ...withoutInstanceId } = BODY;

    expect(validate(withoutInstanceId)).not.toHaveProperty('instanceId');
  });

  it.each(['', 'Prod', '-prod', '.prod', 'has space', 'prod/eu', 'ünïcode', 'a'.repeat(64), 42])(
    'rejects the instanceId %p with a 400',
    (instanceId) => {
      expect(() => validate({ ...BODY, instanceId })).toThrow(BadRequestException);
    },
  );

  it('still requires every other field (full replace)', () => {
    const { enabled: _omitted, ...withoutEnabled } = BODY;

    expect(updateTelemetryConfigSchema.safeParse(withoutEnabled).success).toBe(false);
  });
});

describe('telemetryConfigResponseSchema', () => {
  it('carries instanceIdDefault and instanceIdEffective as strings', () => {
    const response = {
      ...BODY,
      available: true,
      retentionApplicable: true,
      instanceIdDefault: 'my-app',
      instanceIdEffective: 'my-app',
      version: 1,
      updatedAt: null,
      updatedBy: null,
    };

    expect(telemetryConfigResponseSchema.parse(response)).toEqual(response);
    expect(
      telemetryConfigResponseSchema.safeParse({ ...response, instanceIdEffective: undefined }).success,
    ).toBe(false);
  });
});
