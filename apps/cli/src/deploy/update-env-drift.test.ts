import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { openJournal } from './journal.js';
import { composeCwd } from './install.js';
import { parseEnvFile } from './env-spec.js';
import { DEPLOY_STATE_VERSION, type DeployState } from './state.js';
import { buildUpdateSteps } from './update.js';

// =============================================================================
// update's `environment-drift` step: an `allowBlank` key is never a question
// =============================================================================
//
// The PostgreSQL monitor login (#123) is added to the template by a revision;
// blank is a real value for it, so an upgrade must neither open the wizard nor
// refuse a deployment recorded without a domain. A key that genuinely needs an
// answer must still do both (the regression guard).
// =============================================================================

const BASE_TEMPLATE = [
  'NODE_ENV=production',
  'POSTGRES_HOST=db',
  'POSTGRES_PASSWORD=change-me-template',
  'POSTGRES_DB=appdb',
].join('\n');

const BASE_ENV = [
  'NODE_ENV=production',
  'POSTGRES_HOST=db.example.test',
  'POSTGRES_PASSWORD=change-me-operator-value',
  'POSTGRES_DB=appdb',
].join('\n');

function envFilePath(deployRoot: string): string {
  return join(composeCwd(deployRoot), '.env');
}

function driftStep() {
  const step = buildUpdateSteps().find((candidate) => candidate.id === 'environment-drift');
  if (step === undefined) throw new Error('the "environment-drift" step was removed or renamed');
  return step;
}

function fixture(options: { template: string; env: string; domain: string | undefined }) {
  const deployRoot = mkdtempSync(join(tmpdir(), 'evopathcli-update-drift-'));
  mkdirSync(composeCwd(deployRoot), { recursive: true });
  writeFileSync(join(composeCwd(deployRoot), '.env.example'), options.template);
  writeFileSync(envFilePath(deployRoot), options.env);

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };

  const context = {
    // nonInteractive: any attempt to ask would throw rather than hang.
    options: { deployRoot, nonInteractive: true },
    runCommand: (() => {
      throw new Error('the drift step runs no command');
    }) as never,
    journal: openJournal({ deployRoot, command: 'update' }),
    hooks: undefined,
    completed: new Set<string>(),
    state,
    unchanged: false,
    env: undefined as Map<string, string> | undefined,
  };
  return { deployRoot, context };
}

describe('update environment-drift: allowBlank keys need no answer (#123)', () => {
  it('adds the monitor keys blank, without a domain and without the wizard', async () => {
    const { deployRoot, context } = fixture({
      template: `${BASE_TEMPLATE}\nPOSTGRES_MONITOR_USER=\nPOSTGRES_MONITOR_PASSWORD=\n`,
      env: `${BASE_ENV}\n`,
      domain: undefined,
    });

    await expect(driftStep().run(context as never)).resolves.toBeUndefined();

    const written = parseEnvFile(readFileSync(envFilePath(deployRoot), 'utf8'));
    expect(written.get('POSTGRES_MONITOR_USER')).toBe('');
    expect(written.get('POSTGRES_MONITOR_PASSWORD')).toBe('');
    // The operator's own values are untouched.
    expect(written.get('POSTGRES_HOST')).toBe('db.example.test');
    expect(written.get('POSTGRES_PASSWORD')).toBe('change-me-operator-value');
  });

  it('also works with a domain recorded, still without asking', async () => {
    const { deployRoot, context } = fixture({
      template: `${BASE_TEMPLATE}\nPOSTGRES_MONITOR_USER=\nPOSTGRES_MONITOR_PASSWORD=\n`,
      env: `${BASE_ENV}\n`,
      domain: 'app.example.test',
    });

    await driftStep().run(context as never);

    const written = parseEnvFile(readFileSync(envFilePath(deployRoot), 'utf8'));
    expect(written.get('POSTGRES_MONITOR_USER')).toBe('');
    expect(written.get('POSTGRES_MONITOR_PASSWORD')).toBe('');
  });

  it('REGRESSION GUARD: a new essential key that is not allowBlank still needs a domain', async () => {
    const { context } = fixture({
      template: `${BASE_TEMPLATE}\nPOSTGRES_MONITOR_USER=\n`,
      // POSTGRES_DB is essential and absent from this deployment's file.
      env: BASE_ENV.replace('POSTGRES_DB=appdb', '') + '\n',
      domain: undefined,
    });

    await expect(driftStep().run(context as never)).rejects.toBeInstanceOf(UsageError);
  });

  it('REGRESSION GUARD: a new secret key that is not allowBlank still needs an answer', async () => {
    const { context } = fixture({
      template: `${BASE_TEMPLATE}\n`,
      env: BASE_ENV.replace(/^POSTGRES_PASSWORD=.*$/m, '') + '\n',
      domain: undefined,
    });

    await expect(driftStep().run(context as never)).rejects.toBeInstanceOf(UsageError);
  });
});
