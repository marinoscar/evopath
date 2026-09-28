import { APP_SLUG } from '@app/shared';

import { TELEMETRY_INSTANCE_ID_PATTERN } from '../schemas/settings.schema';
import { ATTR_APP_INSTANCE_ID, resolveTelemetryInstanceId } from './instance-id';

// =============================================================================
// resolveTelemetryInstanceId() (issue #565)
// =============================================================================
//
// `null` (the stored default) and "absent" both mean "follow APP_SLUG"; a
// configured value wins verbatim. The last case pins the property the default
// relies on: the slug a fork's product name produces is itself a legal stored
// value, so an administrator can type exactly what the form shows as the
// default.
// =============================================================================

describe('resolveTelemetryInstanceId', () => {
  it('follows APP_SLUG when nothing is configured (null)', () => {
    expect(resolveTelemetryInstanceId(null)).toBe(APP_SLUG);
  });

  it('follows APP_SLUG when the field is absent (undefined)', () => {
    expect(resolveTelemetryInstanceId(undefined)).toBe(APP_SLUG);
  });

  it('treats an empty string like null rather than exporting an empty label', () => {
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
});
