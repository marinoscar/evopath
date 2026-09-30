import { runPrepareContext } from '../nodes/prepare-context.node';
import { contextSourceFixture, FIXTURE_NOW, runContextFixture } from '../testing/context-fixtures';
import { createFakeProgramsPort } from '../testing/fake-programs-port';
import { createNodeContextHarness } from '../testing/node-context-harness';
import { STUB_VERIFIED_BRIEF } from '../testing/stub-agent-nodes';
import { compileDraft } from '../compile/compile-plan';
import { draftFixture } from '../testing/draft-fixtures';
import { HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import {
  BRIEF_REUSE_MAX_AGE_MS,
  briefFromEvidence,
  briefIsFresh,
  citationsOf,
  evidenceOf,
  instructionChangesGoal,
  reusableBrief,
} from './plan-evidence';

const tree = () => compileDraft(draftFixture(), { library: runContextFixture().library, brief: STUB_VERIFIED_BRIEF, seed: 'ev:1' }).tree;
const at = (iso: string) => new Date(iso);

describe('plan evidence', () => {
  it('stores the verified brief as claims and sources and rebuilds it exactly', () => {
    const evidence = evidenceOf(STUB_VERIFIED_BRIEF);
    expect(evidence.filter((e) => e.type === 'claim')).toHaveLength(3);
    expect(evidence.filter((e) => e.type === 'source')).toHaveLength(2);
    expect(briefFromEvidence(evidence)).toEqual(STUB_VERIFIED_BRIEF);
    expect(evidenceOf(null)).toEqual([]);
    expect(briefFromEvidence([])).toBeNull();
    expect(briefFromEvidence([{ type: 'brief', summary: 'x' }])).toBeNull();
    expect(briefFromEvidence('nope')).toBeNull();
  });

  it('cites the sources behind the claims the plan references', () => {
    // The fixture draft cites E1 (S1) and E2 (S1, S2).
    const citations = citationsOf(STUB_VERIFIED_BRIEF, tree());
    expect(citations.map((c) => c.sourceId)).toEqual(['S1', 'S2']);
    expect(citations[0]).toMatchObject({ url: 'https://www.acsm.org/guidelines', claimIds: ['E1', 'E2'] });
    expect(citationsOf(null, tree())).toEqual([]);
  });

  it.each([
    ['Swap Friday for Saturday.', false],
    ['Make the sessions shorter, I only have 45 minutes now.', false],
    ['Change my goal to strength.', true],
    ['My knee pain is back.', true],
    ['I want to focus on fat loss', true],
    ['I injured my shoulder', true],
  ])('instructionChangesGoal(%j) = %s', (instruction, expected) => {
    expect(instructionChangesGoal(instruction)).toBe(expected);
  });

  it('reuses the newest stored brief only while every source is younger than 30 days and the goal is unchanged', () => {
    const stored = [evidenceOf(STUB_VERIFIED_BRIEF)];
    const retrieved = Date.parse('2026-01-01T00:00:00.000Z');
    const fresh = new Date(retrieved + BRIEF_REUSE_MAX_AGE_MS - 1);
    const stale = new Date(retrieved + BRIEF_REUSE_MAX_AGE_MS + 1);

    expect(briefIsFresh(STUB_VERIFIED_BRIEF, fresh)).toBe(true);
    expect(reusableBrief(stored, 'Swap days.', fresh)).toEqual(STUB_VERIFIED_BRIEF);
    expect(reusableBrief(stored, 'Swap days.', stale)).toBeNull();
    expect(reusableBrief(stored, 'New goal: endurance.', fresh)).toBeNull();
    expect(reusableBrief([[], ...stored], 'Swap days.', fresh)).toEqual(STUB_VERIFIED_BRIEF);
    expect(reusableBrief([], 'Swap days.', at('2026-01-02T00:00:00Z'))).toBeNull();
  });
});

describe('prepare_context on a revise run', () => {
  async function run(instruction: string, now: Date) {
    const fake = createFakeProgramsPort();
    const program = fake.addProgram(HARNESS_USER, tree(), { evidence: evidenceOf(STUB_VERIFIED_BRIEF) });
    const source = contextSourceFixture({
      kind: 'revise',
      now,
      revise: { programId: program.id, basedOnVersion: 1, instruction, currentPlan: tree() },
    });
    const h = createNodeContextHarness({
      kind: 'revise',
      now: () => now,
      ports: { plannerContext: { load: async () => source }, programs: fake.port },
    });
    return h.runNode(runPrepareContext, {});
  }

  it('carries the stored brief when it is still fit, and none otherwise', async () => {
    const fresh = new Date(Date.parse('2026-01-10T00:00:00.000Z'));
    expect((await run('Swap Friday for Saturday.', fresh)).brief).toEqual(STUB_VERIFIED_BRIEF);
    expect((await run('Change my goal to strength.', fresh)).brief).toBeUndefined();
    expect((await run('Swap Friday for Saturday.', FIXTURE_NOW)).brief).toBeUndefined();
  });
});
