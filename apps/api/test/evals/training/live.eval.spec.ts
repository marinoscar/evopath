import { PROMPT_VERSIONS } from './prompt-hashes';
import { BASELINES_DIR, readJson, updateRequested, writeBaseline } from './baselines';
import { estimateLiveRun, liveKeyFor, liveReadiness, parseEvalEnv, LIVE_PROVIDERS } from './eval-env';
import { runSamples, type SampledResult } from './live-runner';
import { loadPersonas } from './personas';
import { buildReport, renderMarkdown, reportError, reportPersona, writeReport, type ReportPersona } from './report';
import { createLiveClient } from '../support/live-client';
import { join } from 'node:path';

// =============================================================================
// Model evals: on demand, against real models. NEVER part of CI.
//
// Skipped unless EVAL_LIVE=1, EVAL_MODELS names a planner and a critic, and a
// test key is set for every provider used (`<PROVIDER>_API_KEY_FOR_TESTS`,
// read by the eval only, never by the application, never written to a
// report). The output tells you what is missing.
//
//   EVAL_LIVE=1 OPENAI_API_KEY_FOR_TESTS=sk-... \
//   EVAL_MODELS="planner=openai:gpt-x:high,critic=openai:gpt-y:high" \
//   npm run eval:training --workspace=api
//
// Optional: EVAL_PERSONAS=a,b  EVAL_SAMPLES=3  EVAL_JUDGE=1  EVAL_RESEARCH=live
//           EVAL_CONFIRM=1 (above the cost threshold)  EVAL_LABEL=<name> with
//           EVAL_UPDATE_BASELINE=1 to record baselines/live-<name>.json.
//
// Personas run one after another; a throttle is retried with backoff; a
// partial report is written after each persona so an interruption keeps its
// results. Scores never fail the run: they are compared with a committed
// baseline when one exists and the deltas are printed.
// =============================================================================

const env = parseEvalEnv();
const readiness = liveReadiness(env);

if (!readiness.ready) {
  describe.skip(`live model evals (${readiness.reason})`, () => {
    it('is skipped without EVAL_LIVE=1, EVAL_MODELS and a test key', () => undefined);
  });
} else {
  jest.setTimeout(4 * 60 * 60 * 1000);

  interface LiveBaseline {
    suite: 'training-plan-quality';
    mode: 'live';
    models: Record<string, string>;
    personas: Record<string, { raw: number; shipped: number }>;
  }

  describe('live model evals', () => {
    it('runs the personas against the configured models and reports', async () => {
      const all = loadPersonas();
      const selected = env.personas ? all.filter((p) => env.personas!.includes(p.id)) : all;
      const unknown = (env.personas ?? []).filter((id) => !all.some((p) => p.id === id));
      if (unknown.length > 0) throw new Error(`EVAL_PERSONAS names unknown personas: ${unknown.join(', ')}`);

      const estimate = estimateLiveRun(selected.filter((p) => p.kind === 'create').length, env);
      console.log(`Live eval: ${selected.length} persona(s) x ${env.samples} sample(s), about ${estimate.tokens} tokens (an estimate). Research: ${env.research}.`);
      if (estimate.needsConfirm && !env.confirm) {
        throw new Error(`This run is estimated at ${estimate.tokens} tokens: set EVAL_CONFIRM=1 to run it, or narrow it with EVAL_PERSONAS and EVAL_SAMPLES.`);
      }

      const keys = Object.fromEntries(LIVE_PROVIDERS.flatMap((provider) => {
        const key = liveKeyFor(provider);
        return key ? [[provider, key]] : [];
      }));
      const live = createLiveClient({ keys });

      const sampled: SampledResult[] = [];
      const reports: ReportPersona[] = [];
      for (const persona of selected) {
        const result = await runSamples(persona, env.samples, { live, env });
        sampled.push(result);

        const ok = result.results.find((r) => r.evaluation);
        const samples = { count: env.samples, mean: result.shipped.mean, min: result.shipped.min, max: result.shipped.max, label: env.samples === 1 ? 'single sample' : `${env.samples} samples (mean, min, max of the shipped score)` };
        reports.push(
          ok
            ? reportPersona(ok.evaluation!, { samples, judge: ok.judge ? { goalFit: ok.judge.goalFit, realism: ok.judge.realism, rationaleQuality: ok.judge.rationaleQuality } : null, error: result.results.every((r) => r.error) ? result.results[0].error : null })
            : reportError(persona, result.results[0]?.error ?? 'TRAINING_RUN_FAILED', { latencyMs: result.results[0]?.latencyMs ?? 0, usage: result.results[0]?.usage ?? {} }),
        );

        // A partial report after each persona: an interrupted run keeps what it measured.
        writeReport(buildReport({ mode: 'live', personas: reports, models: env.models, research: env.research, promptVersions: PROMPT_VERSIONS }));
      }

      const report = buildReport({ mode: 'live', personas: reports, models: env.models, research: env.research, promptVersions: PROMPT_VERSIONS });
      const paths = writeReport(report);
      console.log(renderMarkdown(report));
      console.log(`Reports: ${paths.json}, ${paths.md}`);

      const current: LiveBaseline = {
        suite: 'training-plan-quality',
        mode: 'live',
        models: report.models,
        personas: Object.fromEntries(sampled.map((s) => [s.persona.id, { raw: s.raw.mean, shipped: s.shipped.mean }])),
      };
      const baselinePath = join(BASELINES_DIR, `live-${env.label ?? 'default'}.json`);
      const baseline = readJson<LiveBaseline>(baselinePath);
      if (baseline) {
        const lines = Object.entries(current.personas).flatMap(([id, now]) => {
          const before = baseline.personas[id];
          return before ? [`${id}: shipped ${before.shipped.toFixed(3)} -> ${now.shipped.toFixed(3)} (${(now.shipped - before.shipped >= 0 ? '+' : '') + (now.shipped - before.shipped).toFixed(3)}), raw ${before.raw.toFixed(3)} -> ${now.raw.toFixed(3)}`] : [];
        });
        console.log(`Deltas against ${baselinePath}:\n${lines.join('\n')}`);
      }
      if (updateRequested() && env.label) writeBaseline(baselinePath, current);

      // Live scores never fail the run; a run that recorded nothing is a harness failure.
      expect(reports.length).toBe(selected.length);
    });
  });
}
