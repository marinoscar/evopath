import { z } from 'zod';

import { toJsonSchema } from '../../../ai/core/structured-output';
import {
  evidenceBasisOf,
  evidenceBriefSchema,
  knowledgeBriefSchema,
  type EvidenceBrief,
  type VerifiedEvidenceBrief,
  verifiedEvidenceBriefSchema,
} from './evidence-brief.contract';

type JsonNode = Record<string, unknown>;

/** Every object node in a JSON Schema document. */
function objectNodes(node: unknown, out: JsonNode[] = []): JsonNode[] {
  if (Array.isArray(node)) {
    node.forEach((child) => objectNodes(child, out));
  } else if (node && typeof node === 'object') {
    const obj = node as JsonNode;
    if (obj.type === 'object') out.push(obj);
    Object.values(obj).forEach((child) => objectNodes(child, out));
  }
  return out;
}

function validBrief(): EvidenceBrief {
  return {
    summary: 'Train each muscle twice a week with moderate volume.',
    claims: [
      { id: 'E1', topic: 'frequency', claim: 'Twice weekly per muscle.', applicability: 'Fits 3 days.', confidence: 'high', sourceIds: ['S1'] },
      { id: 'E2', topic: 'volume', claim: '10 sets per week.', applicability: 'Beginner.', confidence: 'moderate', sourceIds: ['S1', 'S2'] },
      { id: 'E3', topic: 'progression', claim: 'Add load slowly.', applicability: 'Knee limits.', confidence: 'low', sourceIds: ['S2'] },
    ],
    sources: [
      { id: 'S1', url: 'https://acsm.org/a', title: 'A', publisher: 'ACSM', kind: 'position_stand', year: 2021 },
      { id: 'S2', url: 'https://pubmed.ncbi.nlm.nih.gov/1', title: 'B', publisher: 'NIH', kind: 'meta_analysis', year: null },
    ],
    cautions: [],
  };
}

describe('evidence brief contract', () => {
  it('converts to strict-mode compatible JSON Schema: every property required, every object closed, no records', () => {
    const json = toJsonSchema(evidenceBriefSchema);
    const objects = objectNodes(json);

    expect(objects.length).toBeGreaterThanOrEqual(3);
    for (const obj of objects) {
      const keys = Object.keys((obj.properties as JsonNode) ?? {});
      expect(keys.length).toBeGreaterThan(0);
      expect([...((obj.required as string[]) ?? [])].sort()).toEqual([...keys].sort());
      expect(obj.additionalProperties).toBe(false);
    }
    expect(JSON.stringify(json)).not.toContain('propertyNames');
  });

  it('accepts a valid brief and refuses bad ids, too few claims or sources and too many source ids', () => {
    expect(evidenceBriefSchema.safeParse(validBrief()).success).toBe(true);

    const badId = validBrief();
    badId.sources[0].id = 'source-1';
    expect(evidenceBriefSchema.safeParse(badId).success).toBe(false);

    const fewClaims = validBrief();
    fewClaims.claims = fewClaims.claims.slice(0, 2);
    expect(evidenceBriefSchema.safeParse(fewClaims).success).toBe(false);

    const fewSources = validBrief();
    fewSources.sources = fewSources.sources.slice(0, 1);
    expect(evidenceBriefSchema.safeParse(fewSources).success).toBe(false);

    const manyIds = validBrief();
    manyIds.claims[0].sourceIds = ['S1', 'S2', 'S3', 'S4', 'S5'];
    expect(evidenceBriefSchema.safeParse(manyIds).success).toBe(false);

    const noYear = validBrief() as Record<string, unknown>;
    delete ((noYear.sources as JsonNode[])[0] as JsonNode).year;
    expect(evidenceBriefSchema.safeParse(noYear).success).toBe(false);
  });

  it('the stored (verified) schema matches the VerifiedEvidenceBrief type and refuses unverified sources', () => {
    const stored: VerifiedEvidenceBrief = {
      ...validBrief(),
      sources: validBrief().sources.map((s) => ({ ...s, verified: true as const, domain: 'acsm.org', retrievedAt: new Date().toISOString() })),
      searchQueries: ['strength training frequency'],
      researchMode: 'single',
      basis: 'web_verified',
      droppedClaims: 0,
      droppedSources: 0,
    };
    const parsed: VerifiedEvidenceBrief = verifiedEvidenceBriefSchema.parse(stored);
    expect(parsed).toEqual(stored);

    const unverified = { ...stored, sources: stored.sources.map((s) => ({ ...s, verified: false })) };
    expect(verifiedEvidenceBriefSchema.safeParse(unverified).success).toBe(false);

    const extra = { ...stored, note: 'free text' };
    expect(verifiedEvidenceBriefSchema.safeParse(extra).success).toBe(false);

    // Compile-time: the schema's output is assignable to the interface.
    const assignable: VerifiedEvidenceBrief = {} as z.output<typeof verifiedEvidenceBriefSchema>;
    expect(assignable).toBeDefined();
  });

  function storedBrief(): VerifiedEvidenceBrief {
    return {
      ...validBrief(),
      sources: validBrief().sources.map((s) => ({ ...s, verified: true as const, domain: 'acsm.org', retrievedAt: '2026-01-01T00:00:00.000Z' })),
      searchQueries: [],
      researchMode: 'single',
      basis: 'web_verified',
      droppedClaims: 0,
      droppedSources: 0,
    };
  }

  it('a brief stored before `basis` existed still parses, as web_verified', () => {
    const { basis: _basis, ...legacy } = storedBrief();

    const parsed = verifiedEvidenceBriefSchema.parse(legacy);

    expect(parsed.basis).toBe('web_verified');
    expect(evidenceBasisOf(legacy as VerifiedEvidenceBrief)).toBe('web_verified');
  });

  it('a model_knowledge brief has no sources and no cited claim; claims still number at least three', () => {
    const knowledge: VerifiedEvidenceBrief = {
      ...storedBrief(),
      basis: 'model_knowledge',
      sources: [],
      claims: storedBrief().claims.map((c) => ({ ...c, sourceIds: [] })),
    };
    expect(verifiedEvidenceBriefSchema.safeParse(knowledge).success).toBe(true);

    expect(verifiedEvidenceBriefSchema.safeParse({ ...knowledge, claims: knowledge.claims.slice(0, 2) }).success).toBe(false);
    expect(verifiedEvidenceBriefSchema.safeParse({ ...knowledge, sources: storedBrief().sources }).success).toBe(false);
    // Without the basis it reads as web_verified, which needs sources.
    const { basis: _basis, ...unmarked } = knowledge;
    expect(verifiedEvidenceBriefSchema.safeParse(unmarked).success).toBe(false);
  });

  it('a web_partial brief keeps verified sources with uncited claims beside cited ones; web_verified does not', () => {
    const base = storedBrief();
    const partial: VerifiedEvidenceBrief = {
      ...base,
      basis: 'web_partial',
      sources: base.sources.slice(0, 1),
      claims: [{ ...base.claims[0], sourceIds: ['S1'] }, { ...base.claims[1], sourceIds: [] }, { ...base.claims[2], sourceIds: [] }],
    };
    expect(verifiedEvidenceBriefSchema.safeParse(partial).success).toBe(true);
    expect(verifiedEvidenceBriefSchema.safeParse({ ...partial, basis: 'web_verified' }).success).toBe(false);
    expect(verifiedEvidenceBriefSchema.safeParse({ ...partial, sources: [] }).success).toBe(false);
  });

  it('refuses a claim citing a source the brief does not hold', () => {
    const base = storedBrief();
    const dangling = { ...base, claims: [{ ...base.claims[0], sourceIds: ['S9'] }, ...base.claims.slice(1)] };
    expect(verifiedEvidenceBriefSchema.safeParse(dangling).success).toBe(false);
  });

  it('the knowledge schema is strict-mode compatible and has nowhere to put a source or URL', () => {
    const json = toJsonSchema(knowledgeBriefSchema);
    for (const obj of objectNodes(json)) {
      const keys = Object.keys((obj.properties as JsonNode) ?? {});
      expect([...((obj.required as string[]) ?? [])].sort()).toEqual([...keys].sort());
      expect(obj.additionalProperties).toBe(false);
    }
    const text = JSON.stringify(json);
    expect(text).not.toContain('sourceIds');
    expect(text).not.toContain('"sources"');
    expect(text).not.toContain('"url"');
    expect(knowledgeBriefSchema.safeParse({ summary: 's', claims: validBrief().claims.slice(0, 2), cautions: [] }).success).toBe(false);
  });
});
