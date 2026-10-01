// =============================================================================
// Progress photo privacy (E7.9, #249) — a source tripwire
// =============================================================================
//
// Progress photos are never sent to a model and never appear in a
// notification, push or email payload (coach spec §2.12, §2.14). The coach
// may know only counts and dates, through `ProgressPhotoSummaryService`.
//
// This suite fails the build when:
//   1. the progress-photos module starts importing the AI platform, the
//      orchestration layer, the coach or the notifications module;
//   2. AI, coach, training-agent, notification or email code imports anything
//      of `progress-photos/` other than the summary service (or the module, to
//      wire it), or reads the `progressPhoto` table directly;
//   3. the summary service starts selecting a photo-content field.
//
// The behavioural canary (the summary's output carries no id, URL or note) is
// `src/progress-photos/progress-photo-summary.service.spec.ts`.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '../../src');
const PHOTOS_SRC = join(SRC, 'progress-photos');

/** Directories whose code builds prompts, tool results, notifications, pushes or emails. */
const SENSITIVE_DIRS = ['ai', 'coach', 'training-agents', 'notifications', 'email'];

/** What a sensitive file may import from `progress-photos/`. */
const ALLOWED_IMPORTS = /progress-photos\/(progress-photo-summary\.service|progress-photos\.module)$/;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) specifiers.push(match[1]);
  return specifiers;
}

describe('progress photo privacy (source)', () => {
  const photoFiles = sourceFiles(PHOTOS_SRC);
  const sensitiveFiles = SENSITIVE_DIRS.flatMap((dir) => sourceFiles(join(SRC, dir)));

  it('finds the sources it guards, so the scan cannot pass vacuously', () => {
    expect(photoFiles.map((file) => relative(PHOTOS_SRC, file))).toEqual(
      expect.arrayContaining([
        'progress-photos.service.ts',
        'progress-photos.controller.ts',
        'progress-photo-summary.service.ts',
      ]),
    );
    expect(sensitiveFiles.length).toBeGreaterThan(50);
  });

  it.each(photoFiles.map((file) => [relative(PHOTOS_SRC, file), file]))(
    'progress-photos/%s imports no AI, coach or notification code',
    (_name, file) => {
      const offending = importsOf(readFileSync(file, 'utf8')).filter((specifier) =>
        /(^|\/)(ai|coach|training-agents|notifications|email)(\/|$)|@langchain|openai|@anthropic-ai/.test(specifier),
      );
      expect(offending).toEqual([]);
    },
  );

  it('no AI, coach, notification or email file imports photo content or reads the photo table', () => {
    const offending: string[] = [];

    for (const file of sensitiveFiles) {
      const source = readFileSync(file, 'utf8');
      const name = relative(SRC, file);

      for (const specifier of importsOf(source)) {
        if (specifier.includes('progress-photos') && !ALLOWED_IMPORTS.test(specifier)) {
          offending.push(`${name} imports ${specifier}`);
        }
      }

      if (/\.progressPhoto\b/.test(source)) offending.push(`${name} reads prisma.progressPhoto`);
    }

    expect(offending).toEqual([]);
  });

  it('the summary service selects no photo-content field', () => {
    const source = readFileSync(join(PHOTOS_SRC, 'progress-photo-summary.service.ts'), 'utf8');
    const query = source.slice(source.indexOf('groupBy('), source.indexOf('});', source.indexOf('groupBy(')));

    expect(query).toContain("by: ['pose']");
    expect(query).not.toMatch(/storageObject|note|storageKey|url/i);
  });
});
