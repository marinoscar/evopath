import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// =============================================================================
// Baselines: committed, and rewritten only on purpose (EVAL_UPDATE_BASELINE=1)
// =============================================================================

export const BASELINES_DIR = join(__dirname, 'baselines');
export const PIPELINE_BASELINE = join(BASELINES_DIR, 'pipeline.json');
export const PROMPT_HASHES = join(BASELINES_DIR, 'prompt-hashes.json');

/** A score may dip this far under its baseline (rounding) before it counts as a regression. */
export const SCORE_TOLERANCE = 0.005;

export interface PipelineBaseline {
  suite: 'training-plan-quality';
  mode: 'pipeline';
  personas: Record<string, { good: { raw: number | null; shipped: number | null }; passRate: number }>;
  overall: { passRate: number; meanRaw: number; meanShipped: number };
}

/** `true` only for EVAL_UPDATE_BASELINE=1. */
export function updateRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EVAL_UPDATE_BASELINE === '1';
}

export function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

/** Writes a baseline file. Refuses unless the update was requested. */
export function writeBaseline(path: string, data: unknown, env: NodeJS.ProcessEnv = process.env): void {
  if (!updateRequested(env)) throw new Error('A baseline is only rewritten with EVAL_UPDATE_BASELINE=1');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export interface ScoreDelta {
  id: string;
  layer: 'raw' | 'shipped';
  baseline: number;
  current: number;
  delta: number;
}

/** The scores that fell below the baseline by more than the tolerance. */
export function regressions(current: PipelineBaseline, baseline: PipelineBaseline): ScoreDelta[] {
  const out: ScoreDelta[] = [];
  for (const [id, base] of Object.entries(baseline.personas)) {
    const now = current.personas[id];
    if (!now) continue;
    for (const layer of ['raw', 'shipped'] as const) {
      const b = base.good[layer];
      const c = now.good[layer];
      if (b !== null && c !== null && c < b - SCORE_TOLERANCE) out.push({ id, layer, baseline: b, current: c, delta: Math.round((c - b) * 1000) / 1000 });
    }
  }
  return out;
}

/** Personas the baseline and the current run do not both hold. */
export function personaDrift(current: PipelineBaseline, baseline: PipelineBaseline): { added: string[]; removed: string[] } {
  const now = new Set(Object.keys(current.personas));
  const then = new Set(Object.keys(baseline.personas));
  return { added: [...now].filter((id) => !then.has(id)).sort(), removed: [...then].filter((id) => !now.has(id)).sort() };
}
