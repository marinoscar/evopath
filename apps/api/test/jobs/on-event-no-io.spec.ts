// =============================================================================
// ⚠ NO `@OnEvent` BODY DOES STORAGE I/O (issue #520)
// =============================================================================
//
// CLAUDE.md, "Every Long-Running Activity Is a Queue Job", rule 1: "an
// `@OnEvent` body that downloads or spawns ... [is a] violation".
// `cron-enqueue-only.spec.ts` made the `@Cron` half of that rule executable;
// this is the `@OnEvent` half.
//
// The violation it was written for is the one #520 removed:
// `ObjectProcessingService.handleObjectUploaded`, an `@OnEvent(
// 'storage.object.uploaded', { async: true })` listener that downloaded every
// uploaded object and ran the processors on it inside the event dispatch — no
// worker slot, no timeout, no retry, no row in the admin Jobs page, and an
// object stuck `processing` for ever if the process died mid-run. It is now
// the `storage.object.process` job. The final case below replays that exact
// body through the detector, so this test is known to catch it.
//
// -----------------------------------------------------------------------------
// WHAT IT CHECKS, AND WHAT IT HONESTLY CANNOT
// -----------------------------------------------------------------------------
//
// It reads the BODY of every `@OnEvent`-decorated method under `apps/api/src`
// and fails when it contains a marker of storage I/O: a call on an injected
// storage provider, or a `.download(`/`.upload(` call. It does not follow calls
// into helpers — a listener calling `this.processing.markAbandoned(...)` is
// trusted, and that helper's own spec pins that it is one bounded row. Like
// its `@Cron` sibling, it is a tripwire on the shape of a listener body, not a
// proof about the call graph.
//
// Bounded single-row writes in a listener (`BroadcastFailureListener`,
// `NodeSecretRevoker`, the AI handlers' `failOrphanedRun`) are deliberately
// NOT markers: docs/specs/job-queue.md § "All long-running work is a job"
// names them as outside the rule.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The API's source root, from this file. */
const SRC = join(__dirname, '..', '..', 'src');

/** Markers of a listener moving object bytes itself. */
const IO_MARKERS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bthis\.storage(Provider)?\./, what: 'a direct storage-provider call' },
  { pattern: /\.download\(/, what: 'a download' },
  { pattern: /\.upload\(/, what: 'an upload' },
];

/** Every `.ts` file under `dir`, excluding tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) return [];

    return [full];
  });
}

/**
 * `source` with its comments blanked out.
 *
 * A file's header routinely NAMES `@OnEvent(` in prose (this one does, and so
 * does the handler that replaced the #520 listener); scanning that as code
 * would take the next method in the file as a listener body. Block comments
 * and whole-line `//` comments are removed; a `//` after code on the same line
 * is left alone rather than risk eating a URL inside a string.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Index just past the bracket that closes the one opening at `open`. */
function skipBalanced(source: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === openChar) depth += 1;
    else if (source[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return source.length;
}

/**
 * The body of every `@OnEvent`-decorated method in `source`, brace-matched.
 *
 * Unlike a `@Cron`, the decorator's own arguments routinely contain a brace
 * (`@OnEvent(EVENT, { async: true })`), and so can the method's parameters
 * (`({ job }: JobSettledEvent)`). So the scan skips the decorator's argument
 * list, any further stacked decorators, and the parameter list, and only then
 * takes the next `{` as the body. Taking the first `{` after `@OnEvent(` would
 * read `{ async: true }` as the body — and declare exactly the listener #520
 * removed compliant.
 */
function onEventBodies(source: string): string[] {
  const bodies: string[] = [];
  let index = source.indexOf('@OnEvent(');

  while (index !== -1) {
    // 1. The decorator's argument list.
    let cursor = skipBalanced(source, source.indexOf('(', index), '(', ')');

    // 2. Any further decorators stacked on the same method.
    for (;;) {
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      if (source[cursor] !== '@') break;

      const paren = source.indexOf('(', cursor);
      cursor = skipBalanced(source, paren, '(', ')');
    }

    // 3. The method's parameter list, then its body.
    const params = source.indexOf('(', cursor);

    if (params === -1) break;

    const afterParams = skipBalanced(source, params, '(', ')');
    const open = source.indexOf('{', afterParams);

    if (open === -1) break;

    const end = skipBalanced(source, open, '{', '}');

    bodies.push(source.slice(open, end));
    index = source.indexOf('@OnEvent(', end);
  }

  return bodies;
}

/** Every I/O marker found in `body`. */
function markersIn(body: string): string[] {
  return IO_MARKERS.filter((marker) => marker.pattern.test(body)).map((marker) => marker.what);
}

const files = sourceFiles(SRC)
  .map((file) => ({ path: file, rel: relative(SRC, file).split('\\').join('/') }))
  .map((file) => ({ ...file, source: stripComments(readFileSync(file.path, 'utf8')) }))
  .filter((file) => file.source.includes('@OnEvent('));

describe('no @OnEvent body does storage I/O', () => {
  it('finds the listeners at all, so a broken scan cannot pass vacuously', () => {
    // The failure this guards: a refactor moves the listeners, the scan finds
    // nothing, and the case below passes over an empty list.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.flatMap((file) => onEventBodies(file.source)).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps object bytes out of every event listener', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const body of onEventBodies(file.source)) {
        for (const what of markersIn(body)) {
          offenders.push(`${file.rel}: an @OnEvent body containing ${what}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  describe('the detector', () => {
    it('reads the method body, not the decorator options object', () => {
      const source = `
        @OnEvent(SOME_EVENT, { async: true })
        async handle({ job }: SomeEvent): Promise<void> {
          const x = { nested: true };
          await this.other.thing(x);
        }
      `;

      const [body] = onEventBodies(source);

      expect(body).toContain('this.other.thing(x)');
      expect(body).toContain('nested: true');
    });

    it('ignores @OnEvent named in a comment', () => {
      const source = stripComments(`
        // Before this, an \`@OnEvent(EVENT, { async: true })\` listener did it.
        /* and @OnEvent( here too */
        async run(object: StorageObject): Promise<void> {
          await this.storageProvider.download(object.storageKey);
        }
      `);

      expect(onEventBodies(source)).toEqual([]);
    });

    it('skips stacked decorators', () => {
      const source = `
        @OnEvent(SOME_EVENT)
        @SomethingElse({ a: 1 })
        handle(event: SomeEvent): void {
          void this.storageProvider.download(event.key);
        }
      `;

      expect(onEventBodies(source).flatMap(markersIn)).toEqual([
        'a direct storage-provider call',
        'a download',
      ]);
    });

    it('catches the listener #520 removed', () => {
      // The pre-#520 `ObjectProcessingService.handleObjectUploaded`, trimmed to
      // its shape. If this stops being flagged, the detector has regressed.
      const source = `
        @OnEvent(OBJECT_UPLOADED_EVENT, { async: true })
        async handleObjectUploaded(event: ObjectUploadedEvent): Promise<void> {
          const { object } = event;
          const applicableProcessors = this.processors.filter(p => p.canProcess(object));
          for (const processor of applicableProcessors) {
            try {
              const result = await processor.process(
                object,
                () => this.storageProvider.download(object.storageKey),
              );
            } catch (error) {
              hasError = true;
            }
          }
          await this.markReady(object.id, allMetadata);
        }
      `;

      expect(onEventBodies(source).flatMap(markersIn)).toEqual([
        'a direct storage-provider call',
        'a download',
      ]);
    });
  });
});
