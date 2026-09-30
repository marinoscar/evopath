import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { telemetryGate } from '../../common/otel/telemetry-gate';
import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { TelemetrySettingsService } from '../telemetry-settings.service';

export const TELEMETRY_SETTINGS_PATH = '/admin/settings/telemetry';

/**
 * The exporter endpoint as it is safe to show: scheme, host, port and path.
 * Userinfo and the query string are dropped — an OTLP endpoint can carry a
 * token in either.
 */
export function displayOtlpEndpoint(raw: string | undefined | null): string | null {
  if (!raw || raw.trim() === '') return null;

  try {
    const url = new URL(raw.trim());
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '(unparseable OTEL_EXPORTER_OTLP_ENDPOINT)';
  }
}

/** Pure: the three switches that must all be on for anything to be exported. */
export function decideTelemetryExport(input: {
  collectionEnabled: boolean;
  sdkEnabled: boolean;
  gateOpen: boolean;
  endpoint: string | null;
}): DoctorCheckOutcome {
  const data = {
    collectionEnabled: input.collectionEnabled,
    sdkEnabled: input.sdkEnabled,
    gateOpen: input.gateOpen,
    endpoint: input.endpoint,
  };

  if (!input.collectionEnabled) {
    return { status: 'skip', detail: 'Telemetry collection is off', data };
  }

  if (!input.sdkEnabled) {
    return {
      status: 'fail',
      detail: 'Collection is on in settings, but OTEL_ENABLED is not "true"; this process exports nothing',
      remedy:
        'Set OTEL_ENABLED=true (and OTEL_EXPORTER_OTLP_ENDPOINT) for the api container and restart it, ' +
        'with telemetry.compose.yml in the stack.',
      data,
    };
  }

  if (!input.gateOpen) {
    return {
      status: 'warn',
      detail: 'Collection is on, but the export gate is closed (no usable GreptimeDB connection yet)',
      remedy: `Configure the GreptimeDB connection at ${TELEMETRY_SETTINGS_PATH}; the gate opens within seconds.`,
      data,
    };
  }

  return {
    status: 'pass',
    detail: `Exporting to ${input.endpoint ?? 'the OTLP default endpoint'}`,
    data,
  };
}

/** `telemetry` / `telemetry.export` — this process exports traces, logs and metrics. */
@Injectable()
export class TelemetryExportDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.export';
  readonly category = 'telemetry';
  readonly label = 'Telemetry export';
  readonly settingsPath = TELEMETRY_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly settings: TelemetrySettingsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const policy = await this.settings.getPolicy({ fresh: true });

    return decideTelemetryExport({
      collectionEnabled: policy.enabled,
      sdkEnabled: this.config.get<boolean>('otel.enabled') === true,
      gateOpen: telemetryGate.isEnabled(),
      endpoint: displayOtlpEndpoint(this.config.get<string>('otel.endpoint')),
    });
  }
}
