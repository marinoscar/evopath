import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluatePersona } from './evaluate';
import { loadPersonas } from './personas';
import { PROMPT_VERSIONS } from './prompt-hashes';
import { REPORT_HEADER, buildReport, modelLabel, renderMarkdown, reportPersona, scrub, shouldPrint, writeReport } from './report';

const SENTINEL_KEY = 'sk-sentinel-0123456789abcdef';
const SENTINEL_ENV_VALUE = 'https://internal.example/secret-endpoint-7788';
const SENTINEL_TOKEN = 'abcDEF1234567890.token-value';

async function sampleReport() {
  const personas = loadPersonas();
  const knee = personas.find((p) => p.id === 'knee-pain-intermediate')!;
  const urgent = personas.find((p) => p.id === 'urgent-symptom-text')!;
  const evaluations = [await evaluatePersona(knee, { variant: 'good' }), await evaluatePersona(urgent, { variant: 'good' })];
  return buildReport({
    mode: 'pipeline',
    personas: evaluations.map((e) => reportPersona(e)),
    models: { planner: { provider: 'openai', modelId: 'gpt-x', effort: 'high' } },
    promptVersions: PROMPT_VERSIONS,
    now: new Date('2026-09-30T12:00:00.000Z'),
  });
}

describe('the report', () => {
  it('has the flat, stable shape an external tool can ingest', async () => {
    const report = await sampleReport();

    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'header', 'mode', 'models', 'personas', 'promptVersions', 'research', 'suite', 'summary', 'usage']);
    expect(report.suite).toBe('training-plan-quality');
    expect(report.header).toBe(REPORT_HEADER);
    expect(report.models).toEqual({ planner: 'openai:gpt-x:high' });
    expect(report.promptVersions).toEqual(PROMPT_VERSIONS);
    const knee = report.personas.find((p) => p.id === 'knee-pain-intermediate')!;
    expect(knee.properties.every((p) => ['raw', 'shipped'].includes(p.layer) && typeof p.score === 'number' && typeof p.pass === 'boolean')).toBe(true);
    expect(knee.properties.some((p) => p.layer === 'raw')).toBe(true);
    expect(knee.properties.some((p) => p.layer === 'shipped')).toBe(true);
    expect(knee.samples.label).toBe('single sample');
    expect(Object.keys(report.usage.byRole).sort()).toEqual(['critic', 'planner', 'researcher']);
    expect(report.usage.totalTokens).toBeGreaterThan(0);
    expect(report.summary.personas).toBe(2);
  });

  it('renders a table of personas by property, states the circularity, and names models', async () => {
    const markdown = renderMarkdown(await sampleReport());

    expect(markdown).toContain('| persona | variant | status | raw | shipped |');
    expect(markdown).toContain('knee-pain-intermediate');
    expect(markdown).toContain('partly circular by design');
    expect(markdown).toContain('planner=openai:gpt-x:high');
    expect(markdown).toContain('Tokens by role');
  });

  it('writes <timestamp>-<mode>.json and .md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
    const paths = writeReport(await sampleReport(), dir, {});

    expect(readdirSync(dir).sort()).toEqual(['20260930T120000-pipeline.json', '20260930T120000-pipeline.md']);
    expect(existsSync(paths.json)).toBe(true);
    expect(JSON.parse(readFileSync(paths.json, 'utf8')).suite).toBe('training-plan-quality');
  });

  it('labels a model with its provider, model and effort', () => {
    expect(modelLabel({ provider: 'anthropic', modelId: 'claude-x', effort: null })).toBe('anthropic:claude-x');
  });

  it('prints only from the eval:training script or EVAL_PRINT=1', () => {
    expect(shouldPrint({})).toBe(false);
    expect(shouldPrint({ npm_lifecycle_event: 'eval:training' })).toBe(true);
    expect(shouldPrint({ EVAL_PRINT: '1' })).toBe(true);
  });
});

describe('redaction (sentinel)', () => {
  it('never lets a key, a bearer token or an environment variable value into a written report', async () => {
    const env = { OPENAI_API_KEY_FOR_TESTS: SENTINEL_KEY, SOME_ENDPOINT: SENTINEL_ENV_VALUE, EVAL_LIVE: '1' };
    const report = await sampleReport();
    // Worst case: the values leak into free text the report carries.
    report.personas[0].properties[0].details.push(`key ${SENTINEL_KEY}`, `Authorization: Bearer ${SENTINEL_TOKEN}`, `endpoint ${SENTINEL_ENV_VALUE}`);
    report.personas[0].error = `request failed with ${SENTINEL_KEY}`;

    const dir = mkdtempSync(join(tmpdir(), 'eval-redact-'));
    const { json, md } = writeReport(report, dir, env);
    const written = `${readFileSync(json, 'utf8')}\n${readFileSync(md, 'utf8')}`;

    expect(written).not.toContain(SENTINEL_KEY);
    expect(written).not.toContain(SENTINEL_TOKEN);
    expect(written).not.toContain(SENTINEL_ENV_VALUE);
    expect(written).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(written).toContain('[redacted]');
  });

  it('scrub removes key shapes even without a matching variable', () => {
    expect(scrub('a sk-abcdefghijk1234 b', {})).toBe('a [redacted] b');
    expect(scrub('AIzaSyA1234567890abcdefghijk', {})).toBe('[redacted]');
  });
});
