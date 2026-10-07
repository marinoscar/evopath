import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'yaml';

// =============================================================================
// This app's EFFECTIVE collector config equals the platform's
// (marinoscar/EnterpriseAppBase#719)
// =============================================================================
//
// The OpenTelemetry collector starts with two config files
// (infra/compose/telemetry.compose.yml):
//
//   --config=/etc/otelcol/platform.yaml   infra/otel/otel-collector-config.yaml,
//                                         GENERATED from @marinoscar/platform-infra
//   --config=/etc/otelcol/app.yaml        infra/otel/app-collector.yaml, app-owned
//
// The collector merges them the way otelcol merges several `--config` files:
// maps merge key by key (the later file wins on a shared key), lists are
// REPLACED. This app's collector differences from the platform were comments
// only (the drift baseline), so its overlay carries no configuration and the
// effective config must be exactly the platform's. If an overlay is ever
// added, these cases require it to ADD keys only: it may not change or
// replace anything the platform config sets.
//
// CI's `collector-config` job proves the same with the pinned collector image
// (`otelcol print-config`); this is the dependency-free twin that runs with
// the unit tests.
// =============================================================================

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = dirname(require.resolve('@marinoscar/platform-infra/package.json'));

type Yaml = unknown;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function isMap(value: Yaml): value is Record<string, Yaml> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** otelcol's merge of a later `--config` over an earlier one: maps merge, everything else is replaced. */
function mergeConfigs(base: Yaml, overlay: Yaml): Yaml {
  if (overlay === null || overlay === undefined) return base;
  if (!isMap(base) || !isMap(overlay)) return overlay;
  const merged: Record<string, Yaml> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in base ? mergeConfigs(base[key], value) : value;
  }
  return merged;
}

/** Every leaf path the overlay sets that the base already sets (a change, not an addition). */
function overriddenPaths(base: Yaml, overlay: Yaml, path: string[] = []): string[] {
  if (!isMap(overlay)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(overlay)) {
    if (!isMap(base) || !(key in base)) continue;
    const here = [...path, key];
    if (isMap(base[key]) && isMap(value)) out.push(...overriddenPaths(base[key], value, here));
    else out.push(here.join('.'));
  }
  return out;
}

/** The generated file's body: everything after its two-line GENERATED header. */
function generatedBody(text: string): string {
  const lines = text.split('\n');
  expect(lines[0]).toMatch(/^# GENERATED from @marinoscar\/platform-infra@\S+ \(telemetry\)/);
  expect(lines[1]).toMatch(/^# Source of truth: @marinoscar\/platform-infra\/telemetry\/otel\/otel-collector-config\.yaml/);
  return lines.slice(2).join('\n');
}

describe('collector config parity with @marinoscar/platform-infra', () => {
  const packageBase = read(join(PACKAGE_ROOT, 'telemetry', 'otel', 'otel-collector-config.yaml'));
  const committedBase = read(join(REPO, 'infra', 'otel', 'otel-collector-config.yaml'));
  const appOverlay = read(join(REPO, 'infra', 'otel', 'app-collector.yaml'));

  it("the committed platform config is the package's, byte for byte, under its GENERATED header", () => {
    expect(generatedBody(committedBase)).toBe(packageBase);
  });

  it('the app overlay only ADDS keys: nothing the platform config sets is changed or replaced', () => {
    expect(overriddenPaths(parse(packageBase), parse(appOverlay))).toEqual([]);
  });

  it("the effective config (base, then overlay, merged as otelcol does) equals the package's", () => {
    const base = parse(packageBase);
    const overlay = parse(appOverlay);

    // Today the overlay carries no configuration at all (comments only): this
    // app needs no collector difference of its own.
    expect(overlay ?? null).toBeNull();
    expect(mergeConfigs(base, overlay)).toEqual(base);
  });

  it('the compose file starts the collector with the platform config first and the overlay second', () => {
    const compose = parse(read(join(REPO, 'infra', 'compose', 'telemetry.compose.yml'))) as {
      services: { 'otel-collector': { command: string[]; volumes: string[] } };
    };
    const collector = compose.services['otel-collector'];

    expect(collector.command).toEqual(['--config=/etc/otelcol/platform.yaml', '--config=/etc/otelcol/app.yaml']);
    expect(collector.volumes).toEqual(
      expect.arrayContaining([
        '../otel/otel-collector-config.yaml:/etc/otelcol/platform.yaml:ro',
        '../otel/app-collector.yaml:/etc/otelcol/app.yaml:ro',
      ]),
    );
  });

  describe('the merge rule these cases rely on', () => {
    it('merges maps key by key and replaces lists', () => {
      const base = { service: { pipelines: { metrics: { receivers: ['a', 'b'], exporters: ['x'] } } } };
      const overlay = { service: { pipelines: { metrics: { receivers: ['c'] }, 'metrics/app': { receivers: ['d'] } } } };

      expect(mergeConfigs(base, overlay)).toEqual({
        service: {
          pipelines: { metrics: { receivers: ['c'], exporters: ['x'] }, 'metrics/app': { receivers: ['d'] } },
        },
      });
      expect(overriddenPaths(base, overlay)).toEqual(['service.pipelines.metrics.receivers']);
    });

    it('treats a new named pipeline as an addition', () => {
      const base = { service: { pipelines: { metrics: { receivers: ['a'] } } } };
      const overlay = { receivers: { 'prometheus/app': {} }, service: { pipelines: { 'metrics/app': { receivers: ['prometheus/app'] } } } };

      expect(overriddenPaths(base, overlay)).toEqual([]);
    });
  });
});
