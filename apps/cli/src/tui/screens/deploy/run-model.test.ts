import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../../../branding.js';
import { DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT } from '../../../commands/deploy.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { ENV_METADATA } from '../../../deploy/env-metadata.js';
import {
  FAILURE_TAIL_LINES,
  failingStep,
  failureReport,
  pushBounded,
  rerunCommand,
  shellQuote,
  type StepView,
} from './run-model.js';

// =============================================================================
// A failure must leave something to act on  (issue #393)
// =============================================================================

describe('pushBounded: the failing step’s tail', () => {
  it('keeps the last N lines, oldest first', () => {
    let tail: string[] = [];
    for (let line = 1; line <= 20; line += 1) tail = pushBounded(tail, `line ${line}`, FAILURE_TAIL_LINES);
    expect(tail).toHaveLength(FAILURE_TAIL_LINES);
    expect(tail[0]).toBe(`line ${20 - FAILURE_TAIL_LINES + 1}`);
    expect(tail.at(-1)).toBe('line 20');
  });

  it('does not mutate its input: it is React state', () => {
    const before = Object.freeze(['a', 'b']);
    const after = pushBounded(before, 'c', 2);
    expect(before).toEqual(['a', 'b']);
    expect(after).toEqual(['b', 'c']);
  });

  it('keeps everything under the bound', () => {
    expect(pushBounded(['a'], 'b', 8)).toEqual(['a', 'b']);
  });
});

describe('failingStep', () => {
  const steps: StepView[] = [
    { id: 'doctor', title: 'Check prerequisites', outcome: 'ok' },
    { id: 'build', title: 'Build images', outcome: 'failed', detail: 'exit 1' },
  ];

  it('is the step reported failed', () => {
    expect(failingStep(steps)?.id).toBe('build');
  });

  it('else the step still running: it threw before reporting', () => {
    expect(
      failingStep([
        { id: 'doctor', title: 'Check', outcome: 'ok' },
        { id: 'migrate', title: 'Migrate', outcome: 'running' },
      ])?.id,
    ).toBe('migrate');
  });

  it('is nothing when the run failed before any step started', () => {
    expect(failingStep([])).toBeUndefined();
    expect(failingStep([{ id: 'doctor', title: 'Check', outcome: 'ok' }])).toBeUndefined();
  });
});

describe('failureReport', () => {
  it('names the step, bounds the tail, and carries the journal and the re-run', () => {
    const report = failureReport({
      message: 'Build images failed',
      steps: [{ id: 'build', title: 'Build images', outcome: 'failed' }],
      tail: Array.from({ length: 30 }, (_, index) => `out ${index}`),
      journalPath: '/opt/apps/shop/logs/install.log',
      rerun: 'appctl deploy install --name shop --resume',
    });
    expect(report.step?.id).toBe('build');
    expect(report.tail).toHaveLength(FAILURE_TAIL_LINES);
    expect(report.tail.at(-1)).toBe('out 29');
    expect(report.journalPath).toBe('/opt/apps/shop/logs/install.log');
    expect(report.rerun).toContain('--resume');
  });

  it('omits what it does not know rather than inventing it', () => {
    const report = failureReport({ message: 'x', steps: [], tail: [] });
    expect(report).toEqual({ message: 'x', step: undefined, tail: [] });
  });
});

describe('shellQuote', () => {
  it('leaves plain values alone and single-quotes the rest', () => {
    expect(shellQuote('/opt/apps/shop')).toBe('/opt/apps/shop');
    expect(shellQuote('ops@example.com')).toBe('ops@example.com');
    expect(shellQuote('has space')).toBe("'has space'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});

describe('rerunCommand', () => {
  it('repeats an install with the flags chosen, and --resume', () => {
    const command = rerunCommand({
      action: 'install',
      name: 'shop',
      values: new Map([
        ['__root', deployRootFor(DEFAULT_APPS_ROOT, 'shop')],
        ['__domain', 'shop.example.com'],
        ['__proxyRoot', DEFAULT_PROXY_ROOT],
        ['__port', '3536'],
        ['__proxyMode', 'host'],
        ['__email', 'ops@example.com'],
        ['__group', 'email, observability'],
        ['__ref', ''],
      ]),
      chosen: new Set(['--create-database', '--no-cache', '--skip-oauth-check']),
    });

    expect(command).toBe(
      `${CLI_NAME} deploy install --name shop --domain shop.example.com --port 3536 ` +
        '--proxy-mode host --email ops@example.com --group email --group observability ' +
        '--create-database --skip-oauth-check --no-cache --resume',
    );
  });

  it('uses --root when the root is not the one the name implies', () => {
    const command = rerunCommand({
      action: 'install',
      name: 'shop',
      values: new Map([['__root', '/srv/elsewhere/shop']]),
      chosen: new Set(),
    });
    expect(command).toBe(`${CLI_NAME} deploy install --root /srv/elsewhere/shop --resume`);
  });

  it('leaves off values the subcommand already defaults to', () => {
    const command = rerunCommand({
      action: 'doctor',
      name: 'shop',
      values: new Map([
        ['__proxyRoot', DEFAULT_PROXY_ROOT],
        ['__port', String(DEFAULT_BIND_PORT)],
        ['__domain', ''],
      ]),
      chosen: new Set(),
    });
    expect(command).toBe(`${CLI_NAME} deploy doctor --name shop`);
  });

  it('never offers --resume to a subcommand that does not declare it', () => {
    const update = rerunCommand({
      action: 'update',
      name: 'shop',
      values: new Map([['__ref', 'main'], ['__proxyContainer', 'edge']]),
      chosen: new Set(['--skip-renewal']),
    });
    expect(update).toBe(
      `${CLI_NAME} deploy update --name shop --ref main --proxy-container edge --skip-renewal`,
    );
    expect(update).not.toContain('--resume');
  });

  it('ignores a toggle the action does not offer', () => {
    // --bootstrap-proxy is install-only: repeating it to update would be an
    // unknown option, and the command would fail before doing anything.
    const command = rerunCommand({
      action: 'update',
      name: 'shop',
      values: new Map(),
      chosen: new Set(['--bootstrap-proxy']),
    });
    expect(command).not.toContain('--bootstrap-proxy');
  });

  it('never carries a secret, whatever it is handed', () => {
    // ⚠ Environment answers are where the secrets live. Handing them in by
    // mistake must not put a password in a frame someone screenshots.
    const secretKeys = Object.entries(ENV_METADATA)
      .filter(([, metadata]) => metadata.secret === true)
      .map(([key]) => key);
    expect(secretKeys.length).toBeGreaterThan(0);

    const command = rerunCommand({
      action: 'install',
      name: 'shop',
      values: new Map(secretKeys.map((key) => [key, `value-of-${key}`])),
      chosen: new Set(),
    });
    for (const key of secretKeys) expect(command).not.toContain(`value-of-${key}`);
    expect(command).toBe(`${CLI_NAME} deploy install --name shop --resume`);
  });
});
