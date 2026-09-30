import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Plan signals are facts computed without AI (they work with AI switched
// off), and the aggregator, compactor and contract stay free of Nest and
// Prisma, transitively, so evaluator persona fixtures can run them bare.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function importsOf(path: string): string[] {
  return [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
}

/** Every package a file reaches through its relative imports, itself included. */
function reachablePackages(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  return importsOf(entry).flatMap((spec) => {
    if (!spec.startsWith('.')) return [spec];
    const target = resolve(dirname(entry), `${spec}.ts`);
    return existsSync(target) ? reachablePackages(target, seen) : [];
  });
}

describe('programs/signals imports no AI', () => {
  it.each(sources(__dirname))('%s', (path) => {
    const offending = importsOf(path).filter((spec) => /(^|\/)ai(\/|$)|training-agents|@langchain|openai|@anthropic-ai|@ai-sdk/.test(spec));
    expect(offending).toEqual([]);
  });
});

describe('the pure signal modules reach no Nest or Prisma', () => {
  it.each(['aggregate-signals.ts', 'compact-signals.ts', 'plan-signals.contract.ts'])('%s', (file) => {
    const packages = reachablePackages(join(__dirname, file));
    expect(packages.filter((spec) => spec.startsWith('@nestjs') || spec.startsWith('@prisma'))).toEqual([]);
  });
});
