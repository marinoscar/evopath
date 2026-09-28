import { describe, expect, it } from 'vitest';

import {
  composeBase,
  createDiscovery,
  DiscoveryError,
  parseLabels,
  parsePs,
  psArgv,
  upArgv,
  withTelemetryFiles,
  type ComposeTarget,
} from './compose.js';
import type { CommandRunner, RunResult } from './runner.js';

const DIR = '/opt/infra/apps/acme/repo/infra/compose';
const f = (name: string): string => `${DIR}/${name}`;

const LABELS = {
  'com.docker.compose.project': 'acme',
  'com.docker.compose.project.working_dir': DIR,
  'com.docker.compose.project.config_files': [
    f('base.compose.yml'),
    f('prod.compose.yml'),
    f('telemetry.compose.yml'),
    f('vps.compose.yml'),
    f('vps.telemetry.compose.yml'),
  ].join(','),
  'com.docker.compose.service': 'stack-agent',
};

describe('parseLabels', () => {
  it('reads project, working dir and the ordered file list', () => {
    expect(parseLabels(LABELS)).toEqual({
      project: 'acme',
      workingDir: DIR,
      configFiles: [
        f('base.compose.yml'),
        f('prod.compose.yml'),
        f('telemetry.compose.yml'),
        f('vps.compose.yml'),
        f('vps.telemetry.compose.yml'),
      ],
    });
  });

  it('refuses a container compose did not start', () => {
    expect(() => parseLabels({})).toThrow(DiscoveryError);
    expect(() => parseLabels(null)).toThrow(DiscoveryError);
  });

  it('refuses a project name compose would not accept', () => {
    expect(() => parseLabels({ ...LABELS, 'com.docker.compose.project': 'Acme; rm -rf /' })).toThrow(
      /project/,
    );
  });

  it('refuses relative paths', () => {
    expect(() =>
      parseLabels({ ...LABELS, 'com.docker.compose.project.working_dir': 'infra/compose' }),
    ).toThrow(/working_dir/);
    expect(() =>
      parseLabels({ ...LABELS, 'com.docker.compose.project.config_files': 'base.compose.yml' }),
    ).toThrow(/relative/);
  });

  it('refuses an empty file list', () => {
    expect(() =>
      parseLabels({ ...LABELS, 'com.docker.compose.project.config_files': ' , ' }),
    ).toThrow(DiscoveryError);
  });
});

describe('withTelemetryFiles', () => {
  const everything = (): boolean => true;

  it('inserts both files in the load-bearing order: base, prod, [telemetry], vps, [vps.telemetry]', () => {
    const files = [f('base.compose.yml'), f('prod.compose.yml'), f('vps.compose.yml')];
    expect(withTelemetryFiles(files, everything)).toEqual([
      f('base.compose.yml'),
      f('prod.compose.yml'),
      f('telemetry.compose.yml'),
      f('vps.compose.yml'),
      f('vps.telemetry.compose.yml'),
    ]);
  });

  it('leaves a complete list exactly as it is', () => {
    const files = parseLabels(LABELS).configFiles;
    expect(withTelemetryFiles(files, everything)).toEqual(files);
  });

  it('adds only the missing one', () => {
    const files = [
      f('base.compose.yml'),
      f('prod.compose.yml'),
      f('telemetry.compose.yml'),
      f('vps.compose.yml'),
    ];
    expect(withTelemetryFiles(files, everything)).toEqual([...files, f('vps.telemetry.compose.yml')]);

    const lacksBase = [f('base.compose.yml'), f('prod.compose.yml'), f('vps.compose.yml'), f('vps.telemetry.compose.yml')];
    expect(withTelemetryFiles(lacksBase, everything)).toEqual([
      f('base.compose.yml'),
      f('prod.compose.yml'),
      f('telemetry.compose.yml'),
      f('vps.compose.yml'),
      f('vps.telemetry.compose.yml'),
    ]);
  });

  it('adds nothing that is not on disk', () => {
    const files = [f('base.compose.yml'), f('prod.compose.yml'), f('vps.compose.yml')];
    expect(withTelemetryFiles(files, () => false)).toEqual(files);

    const onlyTelemetry = (path: string): boolean => path.endsWith('/telemetry.compose.yml');
    expect(withTelemetryFiles(files, onlyTelemetry)).toEqual([
      f('base.compose.yml'),
      f('prod.compose.yml'),
      f('telemetry.compose.yml'),
      f('vps.compose.yml'),
    ]);
  });

  it('looks only in the directory of the listed files', () => {
    const seen: string[] = [];
    withTelemetryFiles([f('base.compose.yml'), f('vps.compose.yml')], (path) => {
      seen.push(path);
      return false;
    });
    expect(seen).toEqual([f('telemetry.compose.yml'), f('vps.telemetry.compose.yml')]);
  });

  it('appends telemetry when there is no VPS file to go before', () => {
    expect(withTelemetryFiles([f('base.compose.yml'), f('prod.compose.yml')], (p) => p.endsWith('/telemetry.compose.yml'))).toEqual([
      f('base.compose.yml'),
      f('prod.compose.yml'),
      f('telemetry.compose.yml'),
    ]);
  });
});

function fakeRunner(result: Partial<RunResult>): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: '', output: '', ...result };
  };
  return { runner, calls };
}

describe('createDiscovery', () => {
  it('inspects its own container, once, and completes the file list', async () => {
    const labels = {
      ...LABELS,
      'com.docker.compose.project.config_files': [f('base.compose.yml'), f('prod.compose.yml'), f('vps.compose.yml')].join(','),
    };
    const { runner, calls } = fakeRunner({ stdout: `${JSON.stringify(labels)}\n` });
    const discover = createDiscovery({ runner, containerId: 'a1b2c3d4e5f6', fileExists: () => true });

    const target = await discover();
    await discover();

    expect(calls).toEqual([['docker', 'inspect', '--format', '{{json .Config.Labels}}', 'a1b2c3d4e5f6']]);
    expect(target.project).toBe('acme');
    expect(target.workingDir).toBe(DIR);
    expect(target.files.map((file) => file.slice(DIR.length + 1))).toEqual([
      'base.compose.yml',
      'prod.compose.yml',
      'telemetry.compose.yml',
      'vps.compose.yml',
      'vps.telemetry.compose.yml',
    ]);
  });

  it('does not cache a failure', async () => {
    let attempt = 0;
    const runner: CommandRunner = async () => {
      attempt += 1;
      return attempt === 1
        ? { exitCode: 1, stdout: '', output: 'Cannot connect to the Docker daemon' }
        : { exitCode: 0, stdout: JSON.stringify(LABELS), output: '' };
    };
    const discover = createDiscovery({ runner, containerId: 'a1b2c3d4e5f6', fileExists: () => true });

    await expect(discover()).rejects.toThrow(DiscoveryError);
    await expect(discover()).resolves.toMatchObject({ project: 'acme' });
  });

  it('refuses a HOSTNAME that is not a container reference', async () => {
    const { runner, calls } = fakeRunner({});
    for (const containerId of [undefined, '', '--help', 'a b']) {
      const discover = createDiscovery({ runner, containerId, fileExists: () => true });
      await expect(discover()).rejects.toThrow(DiscoveryError);
    }
    expect(calls).toEqual([]);
  });

  it('refuses output that is not the labels', async () => {
    const { runner } = fakeRunner({ stdout: 'null' });
    const discover = createDiscovery({ runner, containerId: 'abc123', fileExists: () => true });
    await expect(discover()).rejects.toThrow(DiscoveryError);

    const garbage = createDiscovery({
      runner: fakeRunner({ stdout: 'not json' }).runner,
      containerId: 'abc123',
      fileExists: () => true,
    });
    await expect(garbage()).rejects.toThrow(/JSON/);
  });
});

describe('compose argv', () => {
  const target: ComposeTarget = {
    project: 'acme',
    workingDir: DIR,
    files: [f('base.compose.yml'), f('vps.compose.yml')],
  };

  it('pins project, directory and files', () => {
    expect(composeBase(target)).toEqual([
      'docker', 'compose', '--ansi', 'never',
      '-p', 'acme',
      '--project-directory', DIR,
      '-f', f('base.compose.yml'),
      '-f', f('vps.compose.yml'),
    ]);
  });

  it('brings up exactly the two telemetry services, never building, never verbose', () => {
    const argv = upArgv(target);
    expect(argv.slice(composeBase(target).length)).toEqual([
      'up', '-d', '--no-build', 'greptimedb', 'otel-collector',
    ]);
    expect(argv).not.toContain('--verbose');
    expect(argv).not.toContain('--remove-orphans');
  });

  it('lists the two services including stopped containers', () => {
    expect(psArgv(target).slice(composeBase(target).length)).toEqual([
      'ps', '--all', '--format', 'json', 'greptimedb', 'otel-collector',
    ]);
  });
});

describe('parsePs', () => {
  it('reads one object per line', () => {
    const stdout = [
      JSON.stringify({ Service: 'greptimedb', State: 'running', Health: 'healthy' }),
      JSON.stringify({ Service: 'otel-collector', State: 'exited', Health: '' }),
    ].join('\n');
    expect(parsePs(stdout)).toEqual([
      { name: 'greptimedb', state: 'running', health: 'healthy' },
      { name: 'otel-collector', state: 'exited', health: null },
    ]);
  });

  it('reads a JSON array', () => {
    const stdout = JSON.stringify([{ Service: 'otel-collector', State: 'restarting' }]);
    expect(parsePs(stdout)).toEqual([
      { name: 'greptimedb', state: 'missing', health: null },
      { name: 'otel-collector', state: 'restarting', health: null },
    ]);
  });

  it('reports both missing when nothing is printed', () => {
    expect(parsePs('')).toEqual([
      { name: 'greptimedb', state: 'missing', health: null },
      { name: 'otel-collector', state: 'missing', health: null },
    ]);
  });

  it('ignores services it was not asked about and unknown health values', () => {
    const stdout = [
      JSON.stringify({ Service: 'api', State: 'running' }),
      JSON.stringify({ Service: 'greptimedb', State: 'Running', Health: 'weird' }),
    ].join('\n');
    expect(parsePs(stdout)).toEqual([
      { name: 'greptimedb', state: 'running', health: null },
      { name: 'otel-collector', state: 'missing', health: null },
    ]);
  });
});
