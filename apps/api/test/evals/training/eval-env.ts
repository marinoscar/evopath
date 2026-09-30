import { TRAINING_AGENT_ROLES, type TrainingAgentRole } from '../../../src/common/schemas/settings.schema';

// =============================================================================
// EVAL_* variables: read by the eval tests only, never by the application
// =============================================================================
//
// None of these is an application setting and none belongs in `.env.example`
// (AI is configured at runtime in the admin UI). A key comes from
// `<PROVIDER>_API_KEY_FOR_TESTS` and never leaves the test process: it is not
// logged, reported or stored.
// =============================================================================

export const LIVE_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export interface EvalModelSpec {
  provider: LiveProvider;
  modelId: string;
  /** Reasoning effort, when the model takes one. */
  effort: string | null;
}

export interface EvalEnv {
  /** `EVAL_LIVE=1`. */
  live: boolean;
  /** `EVAL_PERSONAS=a,b`; `null` runs every persona. */
  personas: string[] | null;
  /** `EVAL_SAMPLES` (1..10, default 1). */
  samples: number;
  /** `EVAL_JUDGE=1`: the optional, never-gating model-graded score. */
  judge: boolean;
  /** `EVAL_RESEARCH=live` runs the real researcher; default: each persona's stored brief. */
  research: 'stored' | 'live';
  /** `EVAL_MODELS="planner=openai:gpt-x:high,critic=openai:gpt-y:medium"`. */
  models: Partial<Record<TrainingAgentRole, EvalModelSpec>>;
  /** `EVAL_CONFIRM=1`: acknowledges the cost estimate above the threshold. */
  confirm: boolean;
  /** `EVAL_UPDATE_BASELINE=1`: the only way a baseline or prompt hash file is rewritten. */
  updateBaseline: boolean;
  /** `EVAL_LABEL`: names the live baseline file (`live-<label>.json`). */
  label: string | null;
}

export const EVAL_SAMPLES_MAX = 10;
/** Above this many estimated tokens the live run needs `EVAL_CONFIRM=1`. */
export const LIVE_CONFIRM_TOKENS = 500_000;
/** A typical live persona run: research off, one planner draft, one critic round (tokens). */
export const TYPICAL_PERSONA_TOKENS = 150_000;

const flag = (value: string | undefined) => value === '1' || value === 'true';

/** Parses `role=provider:model:effort,...`; throws on a role, provider or shape it does not know. */
export function parseModels(raw: string | undefined): EvalEnv['models'] {
  const models: EvalEnv['models'] = {};
  if (!raw || raw.trim() === '') return models;

  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [role, spec] = entry.split('=');
    if (!spec) throw new Error(`EVAL_MODELS entry "${entry}" is not role=provider:model[:effort]`);
    if (!(TRAINING_AGENT_ROLES as readonly string[]).includes(role)) throw new Error(`EVAL_MODELS names an unknown role "${role}"`);
    const [provider, modelId, effort] = spec.split(':');
    if (!(LIVE_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`EVAL_MODELS names an unsupported provider "${provider}"`);
    if (!modelId) throw new Error(`EVAL_MODELS entry "${entry}" has no model`);
    models[role as TrainingAgentRole] = { provider: provider as LiveProvider, modelId, effort: effort || null };
  }
  return models;
}

export function parseEvalEnv(env: NodeJS.ProcessEnv = process.env): EvalEnv {
  const samples = env.EVAL_SAMPLES === undefined || env.EVAL_SAMPLES === '' ? 1 : Number(env.EVAL_SAMPLES);
  if (!Number.isInteger(samples) || samples < 1 || samples > EVAL_SAMPLES_MAX) throw new Error(`EVAL_SAMPLES must be an integer from 1 to ${EVAL_SAMPLES_MAX}`);
  if (env.EVAL_RESEARCH && !['stored', 'live'].includes(env.EVAL_RESEARCH)) throw new Error('EVAL_RESEARCH must be "stored" or "live"');
  const personas = (env.EVAL_PERSONAS ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const label = (env.EVAL_LABEL ?? '').trim();
  if (label && !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(label)) throw new Error('EVAL_LABEL must be letters, digits, dashes and underscores');

  return {
    live: flag(env.EVAL_LIVE),
    personas: personas.length > 0 ? personas : null,
    samples,
    judge: flag(env.EVAL_JUDGE),
    research: env.EVAL_RESEARCH === 'live' ? 'live' : 'stored',
    models: parseModels(env.EVAL_MODELS),
    confirm: flag(env.EVAL_CONFIRM),
    updateBaseline: env.EVAL_UPDATE_BASELINE === '1',
    label: label || null,
  };
}

/** The test key for a provider, or `undefined`. Read here and nowhere else. */
export function liveKeyFor(provider: LiveProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`${provider.toUpperCase()}_API_KEY_FOR_TESTS`];
  return value && value.trim() !== '' ? value : undefined;
}

/** Whether a live run can start: the flag, and a key for every provider the run uses. */
export function liveReadiness(parsed: EvalEnv, env: NodeJS.ProcessEnv = process.env): { ready: boolean; reason: string } {
  if (!parsed.live) return { ready: false, reason: 'set EVAL_LIVE=1 to run the live evals' };
  const specs = Object.values(parsed.models);
  if (specs.length === 0) return { ready: false, reason: 'set EVAL_MODELS (role=provider:model[:effort])' };
  if (!parsed.models.planner || !parsed.models.critic) return { ready: false, reason: 'EVAL_MODELS must name at least the planner and the critic' };
  for (const provider of new Set(specs.map((s) => s.provider))) {
    if (!liveKeyFor(provider, env)) return { ready: false, reason: `set ${provider.toUpperCase()}_API_KEY_FOR_TESTS` };
  }
  return { ready: true, reason: '' };
}

/** The pre-run estimate: personas x samples x typical tokens, and whether `EVAL_CONFIRM=1` is required. */
export function estimateLiveRun(personaCount: number, parsed: Pick<EvalEnv, 'samples' | 'judge' | 'research'>): { tokens: number; needsConfirm: boolean } {
  const perRun = TYPICAL_PERSONA_TOKENS * (parsed.research === 'live' ? 2 : 1) + (parsed.judge ? 20_000 : 0);
  const tokens = personaCount * parsed.samples * perRun;
  return { tokens, needsConfirm: tokens > LIVE_CONFIRM_TOKENS };
}
