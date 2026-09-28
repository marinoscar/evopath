import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from './executor.js';
import { openJournal } from './journal.js';
import { vhostPath, type ProxyTarget } from './proxy.js';
import { DEPLOY_STATE_VERSION, type DeployState } from './state.js';
import { buildUpdateSteps } from './update.js';

// =============================================================================
// `update`'s `publish` step: `maxBodyBytes` and `proxyRootFor`
// =============================================================================
//
// The step is exercised directly, the same way install.test.ts drives its
// `environment` step: build the exact context shape the pipeline would hand
// it, and call `.run()`. That is cheap and honest here because the bug this
// guards against is entirely in what `publish` PASSES to `installVhost`, not
// in anything upstream of it.
// =============================================================================

/** Always succeeds; installVhost's `nginx -t` / `-s reload` calls don't matter here. */
const okRunCommand: typeof import('./executor.js').runCommand = (async (
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> => ({
  argv: [...argv],
  cwd: options.cwd,
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as typeof import('./executor.js').runCommand;

function publishStep() {
  const step = buildUpdateSteps().find((candidate) => candidate.id === 'publish');
  if (step === undefined) throw new Error('the "publish" step was removed or renamed');
  return step;
}

function baseState(deployRoot: string, domain: string, proxyRoot?: string): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain,
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    ...(proxyRoot === undefined ? {} : { proxyRoot }),
  };
}

/** A pre-existing certificate, so `publish` never tries to issue one. */
function installCert(target: ProxyTarget): void {
  const dir = join(target.proxyRoot, 'letsencrypt', 'live', target.domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fullchain.pem'), '-----BEGIN CERTIFICATE-----\n');
}

function contextFor(options: {
  deployRoot: string;
  state: DeployState;
  env?: Map<string, string>;
}) {
  return {
    options: { deployRoot: options.deployRoot },
    runCommand: okRunCommand,
    journal: openJournal({ deployRoot: options.deployRoot, command: 'update' }),
    hooks: undefined,
    completed: new Set<string>(),
    state: options.state,
    unchanged: false,
    env: options.env,
  };
}

/**
 * A deploy root nested two levels inside a temp directory.
 *
 * ⚠ NOT `mkdtempSync` directly. `proxyRootFor`'s compatibility fallback is
 * `<deployRoot>/../../proxy`, so a root placed straight under /tmp makes that
 * resolve to `/proxy` -- at the FILESYSTEM ROOT. Under the very revert these
 * tests exist to catch, the publish step then writes a vhost there: outside any
 * fixture, surviving the process, and silently poisoning these assertions on
 * every future run. It cost one confusing red suite to find. Nesting keeps the
 * fallback inside the fixture where it can be cleaned up.
 */
function nestedDeployRoot(prefix: string): string {
  const outer = mkdtempSync(join(tmpdir(), prefix));
  const deployRoot = join(outer, 'apps', 'demo');
  mkdirSync(deployRoot, { recursive: true });
  return deployRoot;
}

describe("update's publish step: MAX_FILE_SIZE reaches installVhost's maxBodyBytes", () => {
  it('a configured MAX_FILE_SIZE is reflected in client_max_body_size, not the 100m default', async () => {
    // The regression this pins: an update that carries no MAX_FILE_SIZE of its
    // own re-renders the vhost from scratch, and a missing option silently
    // reverts client_max_body_size to 100m -- every upload above that starts
    // 413ing at the edge after an update that had nothing to do with uploads.
    const deployRoot = nestedDeployRoot('appctl-update-publish-');
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-update-proxy-'));
    const domain = 'app.example.test';
    const state = baseState(deployRoot, domain, proxyRoot);
    installCert({ domain, bindPort: state.bindPort, proxyRoot });

    const context = contextFor({
      deployRoot,
      state,
      env: new Map([['MAX_FILE_SIZE', String(5 * 1024 * 1024)]]),
    });

    await publishStep().run(context as never);

    const rendered = readFileSync(vhostPath({ domain, bindPort: state.bindPort, proxyRoot }), 'utf8');
    expect(rendered).toContain('client_max_body_size 5m;');
    expect(rendered).not.toContain('client_max_body_size 100m;');
  });

  it('a different MAX_FILE_SIZE produces a different limit, so the value genuinely threads through', async () => {
    const deployRoot = nestedDeployRoot('appctl-update-publish-');
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-update-proxy-'));
    const domain = 'app.example.test';
    const state = baseState(deployRoot, domain, proxyRoot);
    installCert({ domain, bindPort: state.bindPort, proxyRoot });

    const context = contextFor({
      deployRoot,
      state,
      env: new Map([['MAX_FILE_SIZE', String(20 * 1024 * 1024)]]),
    });

    await publishStep().run(context as never);

    const rendered = readFileSync(vhostPath({ domain, bindPort: state.bindPort, proxyRoot }), 'utf8');
    expect(rendered).toContain('client_max_body_size 20m;');
  });

  it('no env at all still renders a vhost, defaulting to 100m rather than throwing', async () => {
    const deployRoot = nestedDeployRoot('appctl-update-publish-');
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-update-proxy-'));
    const domain = 'app.example.test';
    const state = baseState(deployRoot, domain, proxyRoot);
    installCert({ domain, bindPort: state.bindPort, proxyRoot });

    const context = contextFor({ deployRoot, state });

    await publishStep().run(context as never);

    const rendered = readFileSync(vhostPath({ domain, bindPort: state.bindPort, proxyRoot }), 'utf8');
    expect(rendered).toContain('client_max_body_size 100m;');
  });
});

describe("update's publish step: proxyRootFor prefers the recorded proxyRoot", () => {
  it('writes the vhost under state.proxyRoot when one was recorded', async () => {
    const deployRoot = nestedDeployRoot('appctl-update-publish-');
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-update-proxy-'));
    const domain = 'app.example.test';
    const state = baseState(deployRoot, domain, proxyRoot);
    installCert({ domain, bindPort: state.bindPort, proxyRoot });

    const context = contextFor({ deployRoot, state });
    await publishStep().run(context as never);

    const recordedPath = vhostPath({ domain, bindPort: state.bindPort, proxyRoot });
    expect(() => readFileSync(recordedPath, 'utf8')).not.toThrow();

    // And NOT at the `<deployRoot>/../../proxy` fallback -- that derivation
    // silently ignores a non-default --proxy-root given at install time.
    const fallback = join(deployRoot, '..', '..', 'proxy');
    if (fallback !== proxyRoot) {
      const fallbackPath = vhostPath({ domain, bindPort: state.bindPort, proxyRoot: fallback });
      expect(() => readFileSync(fallbackPath, 'utf8')).toThrow();
    }
  });

  it('falls back to <deployRoot>/../../proxy only for a record written before proxyRoot existed', async () => {
    // A compatibility path for old state files, not the answer for a new one.
    const outer = mkdtempSync(join(tmpdir(), 'appctl-update-fallback-'));
    const deployRoot = join(outer, 'apps', 'demo');
    mkdirSync(deployRoot, { recursive: true });
    const domain = 'app.example.test';
    const state = baseState(deployRoot, domain); // no proxyRoot recorded
    const fallbackProxyRoot = join(deployRoot, '..', '..', 'proxy');
    installCert({ domain, bindPort: state.bindPort, proxyRoot: fallbackProxyRoot });

    const context = contextFor({ deployRoot, state });
    await publishStep().run(context as never);

    const rendered = readFileSync(
      vhostPath({ domain, bindPort: state.bindPort, proxyRoot: fallbackProxyRoot }),
      'utf8',
    );
    expect(rendered).toContain(`server_name ${domain};`);
  });
});
