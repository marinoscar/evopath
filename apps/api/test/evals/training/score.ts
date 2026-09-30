import { HARD_PROPERTIES, type EvalPersona, type EvalProperty } from './persona.schema';
import { PROPERTY_FNS, type EvalArtifact, type PropertyResult } from './properties';

// =============================================================================
// The scorer: a persona's score is the weighted mean of its properties (hard
// weigh 3, soft 1). A hard failure on the SHIPPED artifact fails the persona
// whatever its score.
// =============================================================================

export const HARD_WEIGHT = 3;
export const SOFT_WEIGHT = 1;

export interface ScoredProperty extends PropertyResult {
  property: EvalProperty;
  kind: 'hard' | 'soft';
  area?: string;
}

export interface LayerScore {
  layer: 'raw' | 'shipped';
  score: number;
  /** Hard properties that failed. */
  hardFailures: EvalProperty[];
  properties: ScoredProperty[];
}

export function weightOf(property: EvalProperty): number {
  return HARD_PROPERTIES.has(property) ? HARD_WEIGHT : SOFT_WEIGHT;
}

/** Runs every property the persona expects over one artifact. */
export function scoreArtifact(persona: EvalPersona, artifact: EvalArtifact): LayerScore {
  const properties: ScoredProperty[] = persona.expect.map((expectation) => ({
    property: expectation.property,
    kind: HARD_PROPERTIES.has(expectation.property) ? 'hard' : 'soft',
    ...(expectation.area ? { area: expectation.area } : {}),
    ...PROPERTY_FNS[expectation.property](persona, artifact, { area: expectation.area }),
  }));
  return summarize(artifact.layer, properties);
}

export function summarize(layer: 'raw' | 'shipped', properties: ScoredProperty[]): LayerScore {
  const totalWeight = properties.reduce((sum, p) => sum + weightOf(p.property), 0);
  const score = totalWeight === 0 ? 0 : properties.reduce((sum, p) => sum + weightOf(p.property) * p.score, 0) / totalWeight;
  return {
    layer,
    score: Math.round(score * 1000) / 1000,
    hardFailures: properties.filter((p) => p.kind === 'hard' && !p.pass).map((p) => p.property),
    properties,
  };
}

/** The persona passes when its shipped artifact has no hard failure. */
export function personaPasses(shipped: LayerScore | null): boolean {
  return shipped === null || shipped.hardFailures.length === 0;
}
