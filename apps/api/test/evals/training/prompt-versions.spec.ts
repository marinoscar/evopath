import { PROMPT_HASHES, readJson, updateRequested, writeBaseline } from './baselines';
import { PROMPT_CHANGED_MESSAGE, PROMPT_FILES, PROMPT_VERSIONS, currentHashes, type PromptHashes } from './prompt-hashes';

// The prompt tripwire: a change to any agent prompt file fails here until the
// evals were run and the pinned hashes were updated on purpose.

describe('prompt versions', () => {
  it('every agent prompt module exports a PROMPT_VERSION', () => {
    expect(Object.keys(PROMPT_VERSIONS).sort()).toEqual(['critic', 'planner', 'researcher']);
    for (const version of Object.values(PROMPT_VERSIONS)) expect(version).toMatch(/^\S+$/);
  });

  it('pins the content of every prompt file', () => {
    const current = currentHashes();

    if (updateRequested()) {
      writeBaseline(PROMPT_HASHES, current);
      return;
    }

    const pinned = readJson<PromptHashes>(PROMPT_HASHES);
    if (!pinned) throw new Error(`No prompt hashes at ${PROMPT_HASHES}. ${PROMPT_CHANGED_MESSAGE}`);

    const changed = PROMPT_FILES.filter((file) => pinned.files[file] !== current.files[file]);
    if (changed.length > 0) throw new Error(`${PROMPT_CHANGED_MESSAGE}\nChanged: ${changed.join(', ')}`);
    expect(Object.keys(pinned.files).sort()).toEqual([...PROMPT_FILES].sort());
    expect(pinned.versions).toEqual(current.versions);
  });
});
