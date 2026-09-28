import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAbout, renderAbout } from './about.js';

function root(document?: unknown): string {
  const deployRoot = mkdtempSync(join(tmpdir(), 'appctl-about-'));
  mkdirSync(join(deployRoot, 'deploy-info'), { recursive: true });
  if (document !== undefined) {
    writeFileSync(
      join(deployRoot, 'deploy-info', 'info.json'),
      typeof document === 'string' ? document : JSON.stringify(document),
    );
  }
  return deployRoot;
}

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    app: {
      name: 'demo',
      version: '1.2.3',
      commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      ref: 'main',
    },
    installedAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    deployedBy: { cli: 'appctl', version: '1.0.0' },
    domain: 'app.example.test',
    remote: null,
    run: { completed: ['preflight'], failedStep: null, outcome: 'success' },
    ...overrides,
  };
}

describe('reading the deployment record', () => {
  it('reports an absent record as absent, not as an error', () => {
    // ⚠ ONE OF THREE NORMAL STATES. A deployment installed before this CLI
    // wrote the document has none, and so does one whose run stopped before the
    // API answered.
    expect(readAbout(root()).status).toBe('absent');
  });

  it('distinguishes an unreadable record from an absent one', () => {
    // ⚠ THE FILE IS THERE AND THIS BUILD CANNOT INTERPRET IT, which is a
    // different condition from nothing being deployed here -- and collapsing
    // the two would tell an operator their deployment does not exist when what
    // is actually wrong is one corrupt file.
    const report = readAbout(root('not json'));

    expect(report.status).toBe('invalid');
    expect(report.error).toBeDefined();
  });

  it('reads a well-formed record', () => {
    const report = readAbout(root(sample()));

    expect(report.status).toBe('ok');
    expect((report.document?.['app'] as Record<string, unknown>)['version']).toBe('1.2.3');
  });
});

describe('rendering it', () => {
  it('does not assert a negative when the record is absent', () => {
    const text = renderAbout(readAbout(root()));

    // ⚠ "no record here" is TRUE; "this was not deployed with the CLI" is a
    // GUESS -- false whenever the file is merely at a mis-set path, on an
    // unattached bind mount, or from a run that stopped early.
    expect(text).toMatch(/No deployment record/i);
    expect(text).not.toMatch(/not deployed with/i);
    expect(text).toMatch(/not necessarily a problem/i);
  });

  it('renders null as a dash rather than the word null', () => {
    // The document uses `null` for known-to-be-absent, and printing the word
    // would read as a value somebody set.
    const text = renderAbout(readAbout(root(sample({ domain: null }))));

    expect(text).toMatch(/Domain\s+-/);
    expect(text).not.toMatch(/null/);
  });

  it('warns when the run that deployed this did not finish', () => {
    // ⚠ THE THIRD STATE, and the reason the document is written at the health
    // gate rather than at the end. Every fact rendered is true; the run that
    // produced them did not reach the end. Reporting the facts without the
    // warning is a half-truth; reporting nothing throws away a working
    // deployment's provenance.
    const text = renderAbout(
      readAbout(
        root(
          sample({
            run: { completed: ['preflight'], failedStep: 'publish', outcome: 'failure' },
          }),
        ),
      ),
    );

    expect(text).toMatch(/did not finish/i);
    expect(text).toMatch(/publish/);
    // And it still shows the facts.
    expect(text).toMatch(/1\.2\.3/);
  });

  it('shows no warning for a run that did finish', () => {
    const text = renderAbout(readAbout(root(sample())));

    expect(text).not.toMatch(/did not finish/i);
  });

  it('abbreviates the commit, which is read by a human here', () => {
    const text = renderAbout(readAbout(root(sample())));

    expect(text).toMatch(/abcdef012345/);
    expect(text).not.toMatch(/abcdef0123456789abcdef/);
  });
});
