import { compileDraft } from '../../compile/compile-plan';
import { applyGuardrails } from '../../guardrails';
import { guardrailContextOf } from '../../guardrails/types';
import { runContextFixture } from '../../testing/context-fixtures';
import { draftFixture } from '../../testing/draft-fixtures';
import { STUB_VERIFIED_BRIEF } from '../../testing/stub-agent-nodes';
import { EVIDENCE_BASIS_NOTES, plannerEvidence } from '../planner/planner.prompt';
import { EVIDENCE_LIMITS, verifiedEvidenceBriefSchema, type KnowledgeBrief, type VerifiedEvidenceBrief } from './evidence-brief.contract';
import {
  MODEL_KNOWLEDGE_CAUTION,
  mergeFallbackBrief,
  STATIC_PRINCIPLES,
  STATIC_SUMMARY,
  WEB_PARTIAL_CAUTION,
} from './knowledge-fallback';

const KNOWLEDGE: KnowledgeBrief = {
  summary: 'Train each muscle twice a week.',
  claims: [
    { id: 'E1', topic: 'frequency', claim: 'Twice a week per muscle.', applicability: 'Fits three days.', confidence: 'high' },
    { id: 'E2', topic: 'volume', claim: 'Add sets gradually.', applicability: 'Beginner.', confidence: 'moderate' },
    { id: 'E3', topic: 'intensity', claim: 'Stop a rep or two short of failure.', applicability: 'All sets.', confidence: 'moderate' },
  ],
  cautions: ['See a professional if pain persists.'],
};

/** An insufficient verified attempt: one source, one claim resting on it. */
function partial(): VerifiedEvidenceBrief {
  return {
    ...STUB_VERIFIED_BRIEF,
    claims: [STUB_VERIFIED_BRIEF.claims[0]],
    sources: [STUB_VERIFIED_BRIEF.sources[0]],
    cautions: ['Evidence is thin.'],
    droppedClaims: 2,
    droppedSources: 1,
  };
}

const base = { researchMode: 'single' as const, searchQueries: ['q'] };

describe('mergeFallbackBrief', () => {
  it('keeps the verified part, appends knowledge claims with no sources and re-numbers E1..En (web_partial)', () => {
    const brief = mergeFallbackBrief({ ...base, partial: partial(), knowledge: KNOWLEDGE });

    expect(verifiedEvidenceBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.basis).toBe('web_partial');
    expect(brief.sources).toEqual([STUB_VERIFIED_BRIEF.sources[0]]);
    expect(brief.claims.map((c) => [c.id, c.sourceIds])).toEqual([
      ['E1', ['S1']],
      ['E2', []],
      ['E3', []],
      ['E4', []],
    ]);
    expect(brief.cautions).toEqual([WEB_PARTIAL_CAUTION, 'Evidence is thin.', 'See a professional if pain persists.']);
    expect(brief.summary).toBe(KNOWLEDGE.summary);
    expect(brief).toMatchObject({ droppedClaims: 2, droppedSources: 1, searchQueries: ['q'], researchMode: 'single' });
  });

  it('without a verified claim the brief is model_knowledge, and sources no claim rests on are dropped and counted', () => {
    const orphan = { ...partial(), claims: [], droppedSources: 1 };
    const brief = mergeFallbackBrief({ ...base, partial: orphan, knowledge: KNOWLEDGE });

    expect(verifiedEvidenceBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief).toMatchObject({ basis: 'model_knowledge', sources: [], droppedSources: 2 });
    expect(brief.cautions[0]).toBe(MODEL_KNOWLEDGE_CAUTION);
  });

  it('a failed knowledge call: the fixed principles, the static summary, still at least three claims', () => {
    const brief = mergeFallbackBrief({ ...base, partial: null, knowledge: null });

    expect(verifiedEvidenceBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.basis).toBe('model_knowledge');
    expect(brief.summary).toBe(STATIC_SUMMARY);
    expect(brief.claims.map((c) => c.claim)).toEqual(STATIC_PRINCIPLES.map((p) => p.claim));
    expect(brief.claims.length).toBeGreaterThanOrEqual(EVIDENCE_LIMITS.minClaims);
    expect(brief.cautions).toEqual([MODEL_KNOWLEDGE_CAUTION]);
    expect(JSON.stringify(brief)).not.toMatch(/https?:\/\//);
  });

  it('knowledge claims emptied by sanitising are topped up from the fixed principles to the minimum', () => {
    const empty: KnowledgeBrief = { ...KNOWLEDGE, claims: KNOWLEDGE.claims.map((c, i) => (i === 0 ? c : { ...c, claim: 'https://x.example.org/a' })) };
    const brief = mergeFallbackBrief({ ...base, partial: null, knowledge: empty });

    expect(brief.claims).toHaveLength(EVIDENCE_LIMITS.minClaims);
    expect(brief.claims[0].claim).toBe(KNOWLEDGE.claims[0].claim);
    expect(brief.claims.slice(1).map((c) => c.claim)).toEqual(STATIC_PRINCIPLES.slice(0, 2).map((p) => p.claim));
  });

  it('caps claims at maxClaims and cautions at maxCautions, keeping the basis caution', () => {
    const many: KnowledgeBrief = {
      summary: 's',
      claims: Array.from({ length: 20 }, (_, i) => ({ id: `E${i + 1}`, topic: 'volume' as const, claim: `Claim ${i}.`, applicability: 'a', confidence: 'low' as const })),
      cautions: Array.from({ length: 6 }, (_, i) => `Caution ${i}.`),
    };
    const brief = mergeFallbackBrief({ ...base, partial: partial(), knowledge: many });

    expect(brief.claims).toHaveLength(EVIDENCE_LIMITS.maxClaims);
    expect(brief.claims[0].sourceIds).toEqual(['S1']);
    expect(brief.cautions).toHaveLength(EVIDENCE_LIMITS.maxCautions);
    expect(brief.cautions[0]).toBe(WEB_PARTIAL_CAUTION);
  });
});

describe('downstream of a knowledge brief', () => {
  const knowledge = mergeFallbackBrief({ ...base, partial: null, knowledge: KNOWLEDGE });

  it('the planner and critic evidence says the basis and carries the fixed note; a web_verified brief is unchanged', () => {
    expect(plannerEvidence(knowledge)).toMatchObject({ basis: 'model_knowledge', note: EVIDENCE_BASIS_NOTES.model_knowledge, sources: [] });
    expect(plannerEvidence(STUB_VERIFIED_BRIEF)).not.toHaveProperty('basis');
    expect(plannerEvidence(STUB_VERIFIED_BRIEF)).not.toHaveProperty('note');
  });

  it('the citation guardrail keeps evidence references to knowledge claims and adds no block', () => {
    const context = runContextFixture();
    const compiled = compileDraft(draftFixture(), { library: context.library, brief: knowledge, seed: 'kb:1' });
    const { tree, report } = applyGuardrails(compiled.tree, guardrailContextOf(context, knowledge));

    const refs = tree.blocks.flatMap((b) => b.weeks.flatMap((w) => w.workouts.flatMap((wo) => wo.exercises.flatMap((e) => e.evidenceRefs))));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => knowledge.claims.some((c) => c.id === ref))).toBe(true);
    expect(report.violations.filter((v) => v.rule === 'G8' && v.code === 'unknown_evidence_ref')).toEqual([]);
    expect(report.violations.filter((v) => v.severity === 'block')).toEqual([]);
  });
});
