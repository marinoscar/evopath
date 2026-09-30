import type { EvalPersona } from './persona.schema';
import { runPersona, type PersonaRun, type PersonaRunOptions } from './run-persona';
import { personaPasses, scoreArtifact, summarize, type LayerScore } from './score';
import { PROPERTY_FNS } from './properties';

export interface PersonaEvaluation {
  persona: EvalPersona;
  run: PersonaRun;
  raw: LayerScore | null;
  shipped: LayerScore | null;
  /** No hard failure on the shipped artifact (or nothing shipped). */
  passes: boolean;
}

/** Runs a persona through the pipeline and scores both layers. */
export async function evaluatePersona(persona: EvalPersona, options: PersonaRunOptions): Promise<PersonaEvaluation> {
  const run = await runPersona(persona, options);

  if (persona.kind === 'safety') {
    const properties = persona.expect.map((e) => ({
      property: e.property,
      kind: 'hard' as const,
      ...PROPERTY_FNS[e.property](persona, { layer: 'shipped', tree: { blocks: [] } as never, ctx: {} as never, safety: run.safety ?? undefined }),
    }));
    const shipped = summarize('shipped', properties);
    return { persona, run, raw: null, shipped, passes: personaPasses(shipped) };
  }

  const raw = run.raw ? scoreArtifact(persona, run.raw) : null;
  const shipped = run.shipped ? scoreArtifact(persona, run.shipped) : null;
  return { persona, run, raw, shipped, passes: personaPasses(shipped) };
}
