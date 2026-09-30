import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PersonaEvaluation } from './evaluate';
import type { EvalModelSpec } from './eval-env';
import type { ScoredProperty } from './score';

// =============================================================================
// Reports: a flat, stable JSON (so an external eval tool can ingest it) and a
// Markdown table, written to `test/evals/reports/<timestamp>-<mode>.{json,md}`
// (git-ignored) and, on request, printed.
//
// A report holds scores, counts and model NAMES. It never holds a key, a
// bearer token or an environment variable value: `scrub` runs over every
// serialised report as a last line of defence, and a sentinel test proves it.
// =============================================================================

export const REPORTS_DIR = join(__dirname, '../reports');

export const REPORT_HEADER =
  'Hard properties on the SHIPPED layer reuse the guardrail tables as instruments, so they are partly circular by design: a green shipped column proves the pipeline applies the guardrails, not that a model plans well. The soft properties and the RAW layer measure the model.';

export interface ReportProperty {
  layer: 'raw' | 'shipped';
  property: string;
  kind: 'hard' | 'soft';
  pass: boolean;
  score: number;
  details: string[];
  area?: string;
}

export interface ReportPersona {
  id: string;
  kind: string;
  variant: string;
  status: string;
  verdict: string | null;
  passes: boolean;
  latencyMs: number;
  rawScore: number | null;
  shippedScore: number | null;
  /** Mean and spread over samples (live runs); a single sample is labelled as such. */
  samples: { count: number; mean: number | null; min: number | null; max: number | null; label: string };
  properties: ReportProperty[];
  usage: Record<string, { inputTokens: number; outputTokens: number }>;
  /** The optional model-graded score (1 to 5), never gating. */
  judge: { goalFit: number; realism: number; rationaleQuality: number } | null;
  /** `AI_STRUCTURED_OUTPUT_INVALID` and friends: a model that could not answer scores 0 for quality. */
  error: string | null;
}

export interface EvalReport {
  suite: 'training-plan-quality';
  mode: 'pipeline' | 'live';
  generatedAt: string;
  header: string;
  /** `role -> provider:model:effort`; empty in pipeline mode (the fake provider). */
  models: Record<string, string>;
  research: 'stored' | 'live';
  personas: ReportPersona[];
  usage: { byRole: Record<string, { inputTokens: number; outputTokens: number }>; totalTokens: number };
  promptVersions: Record<string, string>;
  summary: { personas: number; passed: number; passRate: number; meanRaw: number; meanShipped: number };
}

const mean = (values: number[]) => (values.length === 0 ? 0 : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000);

export function modelLabel(spec: EvalModelSpec): string {
  return `${spec.provider}:${spec.modelId}${spec.effort ? `:${spec.effort}` : ''}`;
}

export function reportPersona(e: PersonaEvaluation, extra: Partial<Pick<ReportPersona, 'judge' | 'error' | 'samples'>> = {}): ReportPersona {
  const properties: ReportProperty[] = [];
  for (const layer of [e.raw, e.shipped]) {
    if (!layer) continue;
    for (const p of layer.properties as ScoredProperty[]) {
      properties.push({ layer: layer.layer, property: p.property, kind: p.kind, pass: p.pass, score: Math.round(p.score * 1000) / 1000, details: p.details, ...(p.area ? { area: p.area } : {}) });
    }
  }
  return {
    id: e.persona.id,
    kind: e.persona.kind,
    variant: e.run.variant,
    status: e.run.status,
    verdict: e.run.verdict,
    passes: e.passes,
    latencyMs: e.run.latencyMs,
    rawScore: e.raw?.score ?? null,
    shippedScore: e.shipped?.score ?? null,
    samples: extra.samples ?? { count: 1, mean: e.shipped?.score ?? e.raw?.score ?? null, min: null, max: null, label: 'single sample' },
    properties,
    usage: e.run.usage,
    judge: extra.judge ?? null,
    error: extra.error ?? null,
  };
}

export function buildReport(args: {
  mode: 'pipeline' | 'live';
  personas: ReportPersona[];
  models?: Record<string, EvalModelSpec | undefined>;
  research?: 'stored' | 'live';
  promptVersions: Record<string, string>;
  now?: Date;
}): EvalReport {
  const byRole: EvalReport['usage']['byRole'] = {};
  for (const persona of args.personas)
    for (const [role, u] of Object.entries(persona.usage)) {
      const entry = (byRole[role] ??= { inputTokens: 0, outputTokens: 0 });
      entry.inputTokens += u.inputTokens;
      entry.outputTokens += u.outputTokens;
    }
  const scored = args.personas.filter((p) => p.kind !== 'safety');

  return {
    suite: 'training-plan-quality',
    mode: args.mode,
    generatedAt: (args.now ?? new Date()).toISOString(),
    header: REPORT_HEADER,
    models: Object.fromEntries(Object.entries(args.models ?? {}).flatMap(([role, spec]) => (spec ? [[role, modelLabel(spec)]] : []))),
    research: args.research ?? 'stored',
    personas: args.personas,
    usage: { byRole, totalTokens: Object.values(byRole).reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0) },
    promptVersions: args.promptVersions,
    summary: {
      personas: args.personas.length,
      passed: args.personas.filter((p) => p.passes).length,
      passRate: args.personas.length === 0 ? 0 : Math.round((args.personas.filter((p) => p.passes).length / args.personas.length) * 1000) / 1000,
      meanRaw: mean(scored.flatMap((p) => (p.rawScore === null ? [] : [p.rawScore]))),
      meanShipped: mean(scored.flatMap((p) => (p.shippedScore === null ? [] : [p.shippedScore]))),
    },
  };
}

/** Markdown: one row per persona and variant, one column per property of the SHIPPED layer, raw score beside it. */
export function renderMarkdown(report: EvalReport): string {
  const properties = [...new Set(report.personas.flatMap((p) => p.properties.filter((x) => x.layer === 'shipped').map((x) => x.property)))];
  const cell = (p: ReportPersona, property: string) => {
    const found = p.properties.find((x) => x.layer === 'shipped' && x.property === property);
    return found ? (found.pass ? found.score.toFixed(2) : `FAIL ${found.score.toFixed(2)}`) : '-';
  };
  const lines = [
    `# Plan-quality evals (${report.mode})`,
    '',
    `Generated ${report.generatedAt}. Research: ${report.research}.`,
    '',
    `> ${report.header}`,
    '',
    `Models: ${Object.keys(report.models).length === 0 ? 'the scripted fake provider' : Object.entries(report.models).map(([role, m]) => `${role}=${m}`).join(', ')}`,
    `Prompt versions: ${Object.entries(report.promptVersions).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Pass rate: ${report.summary.passed}/${report.summary.personas} (${Math.round(report.summary.passRate * 100)}%). Mean score: raw ${report.summary.meanRaw.toFixed(3)}, shipped ${report.summary.meanShipped.toFixed(3)}.`,
    '',
    `| persona | variant | status | raw | shipped | ${properties.join(' | ')} | ms |`,
    `|---|---|---|---|---|${properties.map(() => '---').join('|')}|---|`,
    ...report.personas.map(
      (p) =>
        `| ${p.id} | ${p.variant} | ${p.status}${p.error ? ` (${p.error})` : ''} | ${p.rawScore === null ? '-' : p.rawScore.toFixed(2)} | ${p.shippedScore === null ? '-' : p.shippedScore.toFixed(2)} | ${properties.map((x) => cell(p, x)).join(' | ')} | ${p.latencyMs} |`,
    ),
    '',
    `Tokens by role: ${Object.entries(report.usage.byRole).map(([role, u]) => `${role} ${u.inputTokens} in / ${u.outputTokens} out`).join('; ') || 'none'} (total ${report.usage.totalTokens}).`,
  ];
  const judged = report.personas.filter((p) => p.judge);
  if (judged.length > 0) {
    lines.push('', 'Model-graded scores (1 to 5, never gating):', '', '| persona | goal fit | realism | rationale |', '|---|---|---|---|', ...judged.map((p) => `| ${p.id} | ${p.judge!.goalFit} | ${p.judge!.realism} | ${p.judge!.rationaleQuality} |`));
  }
  return `${lines.join('\n')}\n`;
}

const SECRET_PATTERNS = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\bAIza[0-9A-Za-z_-]{20,}/g];

/** Removes anything that looks like a key or token, and every environment variable value of 12 or more characters. */
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  for (const value of new Set(Object.values(env))) {
    if (typeof value === 'string' && value.length >= 12 && out.includes(value)) out = out.split(value).join('[redacted]');
  }
  return out;
}

/** Writes `<timestamp>-<mode>.json` and `.md`; returns their paths. Scrubbed. */
export function writeReport(report: EvalReport, dir: string = REPORTS_DIR, env: NodeJS.ProcessEnv = process.env): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const base = join(dir, `${stamp}-${report.mode}`);
  writeFileSync(`${base}.json`, scrub(`${JSON.stringify(report, null, 2)}\n`, env));
  writeFileSync(`${base}.md`, scrub(renderMarkdown(report), env));
  return { json: `${base}.json`, md: `${base}.md` };
}

/** Whether to print the table: the `eval:training` script, or EVAL_PRINT=1. */
export function shouldPrint(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_lifecycle_event === 'eval:training' || env.EVAL_PRINT === '1';
}
