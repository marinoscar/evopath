import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROMPT_VERSION as CRITIC } from '../../../src/training-agents/agents/critic/critic.prompt';
import { PROMPT_VERSION as PLANNER } from '../../../src/training-agents/agents/planner/planner.prompt';
import { PROMPT_VERSION as RESEARCHER } from '../../../src/training-agents/agents/researcher/researcher.prompt';

// The prompt files whose text drives model behaviour. `PROMPT_VERSION` is what
// a report records; the content hash is what the tripwire pins.

export const API_ROOT = join(__dirname, '../../..');

export const PROMPT_FILES = [
  'src/training-agents/agents/planner/planner.prompt.ts',
  'src/training-agents/agents/critic/critic.prompt.ts',
  'src/training-agents/agents/researcher/researcher.prompt.ts',
  'src/training-agents/agents/shared/prompt-blocks.ts',
] as const;

export const PROMPT_VERSIONS: Record<string, string> = { planner: PLANNER, critic: CRITIC, researcher: RESEARCHER };

export interface PromptHashes {
  versions: Record<string, string>;
  files: Record<string, string>;
}

/** sha256 of a file's text with line endings normalised. */
export function hashFile(relativePath: string): string {
  const text = readFileSync(join(API_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

export function currentHashes(): PromptHashes {
  return { versions: { ...PROMPT_VERSIONS }, files: Object.fromEntries(PROMPT_FILES.map((f) => [f, hashFile(f)])) };
}

export const PROMPT_CHANGED_MESSAGE =
  'A prompt changed: run `npm run eval:training` (and the live evals if the change affects behaviour), then update the baselines with EVAL_UPDATE_BASELINE=1 and note the result in the PR.';
