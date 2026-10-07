import { APP_SLUG } from '@app/shared';
import { telemetryGate } from '@marinoscar/platform-api/otel-core/sdk';

import { TELEMETRY_INSTANCE_ID_PATTERN } from '../schemas/settings.schema';
import { ATTR_APP_INSTANCE_ID, resolveServiceName, resolveTelemetryInstanceId } from './telemetry-identity';

// =============================================================================
// This app's telemetry identity (issues #343, #565; bound here by marinoscar/EnterpriseAppBase#700)
// =============================================================================
//
// The package resolvers take the fallback from the caller; this file pins
// that the app binds them to APP_SLUG, so a renamed fork follows its new name
// (the resolvers themselves are pinned by the package's service-name and
// instance-id specs).
// =============================================================================

describe('resolveServiceName (app binding)', () => {
  const ORIGINAL = process.env.OTEL_SERVICE_NAME;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = ORIGINAL;
  });

  it('returns OTEL_SERVICE_NAME verbatim when set', () => {
    process.env.OTEL_SERVICE_NAME = 'custom-service-name';
    expect(resolveServiceName()).toBe('custom-service-name');
  });

  it('falls back to `${APP_SLUG}-api` when unset or empty, per call', () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);
    process.env.OTEL_SERVICE_NAME = '';
    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);
    process.env.OTEL_SERVICE_NAME = 'second-value';
    expect(resolveServiceName()).toBe('second-value');
  });
});

describe('resolveTelemetryInstanceId (app binding)', () => {
  it('follows APP_SLUG when nothing (null, undefined, "") is configured', () => {
    expect(resolveTelemetryInstanceId(null)).toBe(APP_SLUG);
    expect(resolveTelemetryInstanceId(undefined)).toBe(APP_SLUG);
    expect(resolveTelemetryInstanceId('')).toBe(APP_SLUG);
  });

  it('returns an administrator-set value verbatim', () => {
    expect(resolveTelemetryInstanceId('prod-eu.1')).toBe('prod-eu.1');
  });

  it('exports under the app.instance.id attribute key', () => {
    expect(ATTR_APP_INSTANCE_ID).toBe('app.instance.id');
  });

  it('defaults to a value the settings pattern itself accepts', () => {
    expect(TELEMETRY_INSTANCE_ID_PATTERN.test(APP_SLUG)).toBe(true);
  });

  it('seeds the export gate with APP_SLUG when loaded, so the first batch is never unlabelled', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const gate = (require('@marinoscar/platform-api/otel-core/sdk') as { telemetryGate: typeof telemetryGate })
        .telemetryGate;
      expect(gate.instanceId()).not.toBe(APP_SLUG);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./telemetry-identity');
      expect(gate.instanceId()).toBe(APP_SLUG);
    });
    expect(telemetryGate.instanceId()).toBe(APP_SLUG);
  });
});
