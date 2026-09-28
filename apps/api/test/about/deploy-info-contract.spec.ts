import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDeployInfo } from '../../src/about/deploy-info';

// =============================================================================
// The document the CLI writes is one this reader accepts  (issue #407)
// =============================================================================
//
// ⚠ TWO PROGRAMS, ONE DOCUMENT, AND NOTHING MADE THEM AGREE. The reader here,
// the bind mount in `vps.compose.yml` and the Console's About page all shipped
// before anything wrote the file at all, so `absent` was the only state any of
// them had ever actually seen. A writer and a reader that have never met is
// exactly the shape the spec's closing note warns about: a module that keeps
// working correctly while a neighbouring one changes its meaning.
//
// The CLI cannot be imported from here -- `apps/cli`'s tsconfig pins `rootDir`
// to its own `src`, and this package has no dependency on it -- so this test
// carries the document SHAPE rather than calling the builder. That is a real
// limitation and worth naming: if the two drift, this test still passes and
// the About page goes blank. What it does catch is the reader changing its
// mind about a document the CLI is known to produce, which is the direction
// this pair has actually moved.
//
// The CLI side asserts the same shape from its end, in
// `apps/cli/src/deploy/testing/fake-vps.test.ts`.
// =============================================================================

/** Byte-for-byte the shape `apps/cli/src/deploy/deploy-info.ts` emits. */
function documentAsTheCliWritesIt(): Record<string, unknown> {
  return {
    schema: 1,
    app: {
      name: 'e2e',
      version: '1.0.1',
      commitSha: 'a'.repeat(40),
      ref: 'main',
    },
    installedAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:05:00.000Z',
    deployedBy: { cli: 'appctl', version: '1.0.0' },
    domain: 'app.example.test',
    remote: null,
    run: {
      completed: ['preflight', 'checkout', 'environment'],
      failedStep: null,
      outcome: 'success',
    },
  };
}

function write(document: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'deploy-info-contract-')), 'info.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

describe('the deploy-info contract between the CLI and this API', () => {
  it('reads the CLI document as ok, with every field populated', async () => {
    const result = await readDeployInfo(write(documentAsTheCliWritesIt()));

    expect(result.status).toBe('ok');
    expect(result.document?.app.version).toBe('1.0.1');
    expect(result.document?.app.commitSha).toBe('a'.repeat(40));
    expect(result.document?.deployedBy?.cli).toBe('appctl');
    expect(result.document?.domain).toBe('app.example.test');
    expect(result.document?.run?.completed).toEqual([
      'preflight',
      'checkout',
      'environment',
    ]);
  });

  it('accepts the CLI writing null for a fact it does not have', async () => {
    // ⚠ `null` IS THE IDIOM, not an omitted key, and `remote` is the live
    // example: the CLI does not ask the remote how far ahead it is at deploy
    // time, and "0 commits behind" would be a claim rather than an absence.
    const result = await readDeployInfo(write(documentAsTheCliWritesIt()));

    expect(result.status).toBe('ok');
    expect(result.document?.remote).toBeNull();
  });

  it('renders the third state: complete, but the run did not finish', async () => {
    // The About page needs all three states, and this is the one that only
    // exists because the document is written at the HEALTH GATE rather than at
    // the end of the pipeline -- so a run that died in `publish` still leaves a
    // document describing a deployment that is up and serving.
    const document = documentAsTheCliWritesIt();
    document['run'] = {
      completed: ['preflight', 'checkout', 'environment', 'build'],
      failedStep: 'publish',
      outcome: 'failure',
    };

    const result = await readDeployInfo(write(document));

    expect(result.status).toBe('ok');
    expect(result.document?.run?.outcome).toBe('failure');
    expect(result.document?.run?.failedStep).toBe('publish');
  });
});
