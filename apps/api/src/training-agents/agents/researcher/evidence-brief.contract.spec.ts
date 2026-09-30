import { z } from 'zod';

import { toJsonSchema } from '../../../ai/core/structured-output';
import {
  evidenceBriefSchema,
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
});
