import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Today's planned workout works with AI switched off and for manual plans:
// nothing under this directory may import the AI platform or an SDK.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('programs/today imports no AI', () => {
  it.each(sources(__dirname))('%s', (path) => {
    const imports = [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const offending = imports.filter((spec) => /(^|\/)ai(\/|$)|training-agents|@langchain|openai|@anthropic-ai|@ai-sdk/.test(spec));
    expect(offending).toEqual([]);
  });
});
