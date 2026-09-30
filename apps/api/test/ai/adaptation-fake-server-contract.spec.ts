import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiError } from '../../src/ai/core/ai-error';
import { AI_KEYLESS_API_KEY, type AiCallContext } from '../../src/ai/core/provider-adapter.interface';
import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import { OpenAiCompatibleClientFactory } from '../../src/ai/providers/openai-compatible/openai-compatible-client.factory';
import { OpenAiCompatibleProviderAdapter } from '../../src/ai/providers/openai-compatible/openai-compatible.adapter';
import { adaptationCritiqueModelSchema } from '../../src/training-adaptation/contracts/adaptation-critique.contract';
import { adaptationProposalModelSchema } from '../../src/training-adaptation/contracts/adapted-workout.contract';
import { ADAPT_INSTRUCTIONS, renderAdaptInput } from '../../src/training-adaptation/prompts/adapt.prompt';
import { CRITIC_INSTRUCTIONS, renderCriticInput } from '../../src/training-adaptation/prompts/critic.prompt';
import {
  ADAPTATION_CRITIQUE_SCHEMA_NAME,
  ADAPTATION_PROPOSAL_SCHEMA_NAME,
  CONTEXT_JSON_CLOSE,
  CONTEXT_JSON_OPEN,
  CRITIC_NOTES_CLOSE,
  CRITIC_NOTES_OPEN,
} from '../../src/training-adaptation/prompts/markers';
import {
  adaptationContextFixture,
  onlyDumbbellsRequest,
} from '../../src/training-adaptation/testing/adaptation-fixtures';

// =============================================================================
// The fake server's contract with the adaptation prompts (E6.4)
// =============================================================================
//
// `tests/e2e/support/fake-vision-server.mjs` (with `fake-adaptation-scenarios.mjs`)
// is the deterministic provider of the e2e stack. It finds the minimised
// context by the literal markers and answers by structured-output schema name.
// This suite fails when:
//   - a marker or schema name changes on either side;
//   - a prompt builder stops emitting the context block the fake parses;
//   - the fake's answers stop parsing under the REAL structured-output
//     schemas, through the REAL OpenAI-compatible adapter;
//   - scenario selection stops being deterministic.
// The fake is started as a child process, like the other fake-server suites.
// =============================================================================

const SUPPORT = join(__dirname, '..', '..', '..', '..', 'tests', 'e2e', 'support');
const SERVER = join(SUPPORT, 'fake-vision-server.mjs');
const SCENARIOS_MODULE = join(SUPPORT, 'fake-adaptation-scenarios.mjs');

/** `export const NAME = 'literal';` from the fake's scenarios module, read as text (it is ESM; Jest is CommonJS). */
function fakeConstant(name: string): string {
  const source = readFileSync(SCENARIOS_MODULE, 'utf8');
  const match = new RegExp(`export const ${name} = '([^']*)';`).exec(source);
  if (!match) throw new Error(`fake-adaptation-scenarios.mjs no longer exports ${name} as a string literal`);
  return match[1];
}

describe('fake server contract: literals', () => {
  it.each([
    ['CONTEXT_JSON_OPEN', CONTEXT_JSON_OPEN],
    ['CONTEXT_JSON_CLOSE', CONTEXT_JSON_CLOSE],
    ['CRITIC_NOTES_OPEN', CRITIC_NOTES_OPEN],
    ['CRITIC_NOTES_CLOSE', CRITIC_NOTES_CLOSE],
    ['SCHEMA_PROPOSAL', ADAPTATION_PROPOSAL_SCHEMA_NAME],
    ['SCHEMA_CRITIQUE', ADAPTATION_CRITIQUE_SCHEMA_NAME],
  ])('%s equals the application constant', (name, expected) => {
    expect(fakeConstant(name)).toBe(expected);
  });

  it('the scan schema name is the one the gym scan sends', () => {
    expect(fakeConstant('SCHEMA_SCAN')).toBe('gym_equipment_scan');
  });
});

describe('fake server contract: prompt builders', () => {
  const context = adaptationContextFixture({ request: onlyDumbbellsRequest() });

  it('the planner input carries the context block, and a revise pass the critic notes', () => {
    const first = renderAdaptInput(context.sent);
    expect(first).toContain(CONTEXT_JSON_OPEN);
    expect(first).toContain(CONTEXT_JSON_CLOSE);
    expect(first).not.toContain(CRITIC_NOTES_OPEN);

    const revised = renderAdaptInput(context.sent, {
      previous: { exercises: [], estimatedMinutes: 20 },
      critique: { round: 1, verdict: 'revise', checks: { honoursRequest: false, preservesIntent: true, avoidsSoreAreas: true, sensibleOrder: true }, issues: [] },
    });
    expect(revised).toContain(CRITIC_NOTES_OPEN);
    expect(revised).toContain(CRITIC_NOTES_CLOSE);
  });

  it('the critic input carries the context block', () => {
    const input = renderCriticInput(context.sent, {
      title: 't',
      summary: 's',
      estimatedMinutes: 20,
      exercises: [],
      dropped: [],
      rationale: ['r'],
      uncertainty: [],
    } as never, { repairs: [], rejected: [], estimatedMinutes: 20, fitsRequest: true, promptVersion: 1, warnings: [] });
    expect(input).toContain(CONTEXT_JSON_OPEN);
  });

  it('the instructions mention the markers before the block, so the fake must read user messages only', () => {
    // The system prompt names both markers in prose; a fake that parsed the
    // whole text would stop at the first `<context-json>` and read " and ".
    expect(ADAPT_INSTRUCTIONS.indexOf(CONTEXT_JSON_OPEN)).toBeGreaterThanOrEqual(0);
    expect(CRITIC_INSTRUCTIONS.indexOf(CONTEXT_JSON_OPEN)).toBeGreaterThanOrEqual(0);
  });
});

describe('fake server contract: through the real OpenAI-compatible adapter', () => {
  let child: ChildProcess;
  let base: string;
  const adapter = new OpenAiCompatibleProviderAdapter(new AiProviderRegistry(), new OpenAiCompatibleClientFactory());

  beforeAll(async () => {
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake server did not start')), 10_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        const match = /listening on :(\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on('exit', (code) => reject(new Error(`fake server exited with ${code}`)));
    });
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    child?.kill();
  });

  const control = (path: string, body?: unknown) =>
    fetch(`${base}/__control${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeEach(async () => {
    await control('/reset', {});
    await control('/scenario', { name: 'valid' });
  });

  const ctx = (): AiCallContext => ({
    apiKey: AI_KEYLESS_API_KEY,
    baseUrl: `${base}/v1`,
    requestId: 'req-adaptation-contract',
    providerSettings: { apiStyle: 'chat_completions', requiresKey: false },
  });

  // The planner and the critic, exactly as the graph nodes ask (schema, name, instructions, input).
  const plan = (input: string, model = 'fake-planner') =>
    adapter.responses.create(
      { model, instructions: ADAPT_INSTRUCTIONS, input, structuredOutput: { name: ADAPTATION_PROPOSAL_SCHEMA_NAME, schema: adaptationProposalModelSchema, strict: true } },
      ctx(),
    );
  const critique = (input: string) =>
    adapter.responses.create(
      { model: 'fake-critic', instructions: CRITIC_INSTRUCTIONS, input, structuredOutput: { name: ADAPTATION_CRITIQUE_SCHEMA_NAME, schema: adaptationCritiqueModelSchema, strict: true } },
      ctx(),
    );

  const context = adaptationContextFixture({ request: onlyDumbbellsRequest() });

  it('answers the planner from the request context with exercises it contains, and reports the scripted usage', async () => {
    const response = await plan(renderAdaptInput(context.sent));
    const proposal = adaptationProposalModelSchema.parse(response.parsed);

    expect(proposal.exercises.length).toBeGreaterThan(0);
    const allowed = new Set([...(context.sent.today?.exercises.map((e) => e.key) ?? []), ...context.sent.candidates.map((c) => c.key)]);
    for (const exercise of proposal.exercises) expect(allowed.has(exercise.exerciseKey)).toBe(true);
    expect(response.usage.inputTokens).toBe(1200);
    expect(response.usage.outputTokens).toBe(300);
  });

  it('answers the critic with an accept that parses under the real schema and reports the scripted usage', async () => {
    const response = await critique(
      renderCriticInput(
        context.sent,
        { title: 't', summary: 's', estimatedMinutes: 20, exercises: [], dropped: [], rationale: ['r'], uncertainty: [] } as never,
        { repairs: [], rejected: [], estimatedMinutes: 20, fitsRequest: true, promptVersion: 1, warnings: [] },
      ),
    );
    expect(adaptationCritiqueModelSchema.parse(response.parsed).verdict).toBe('accept');
    expect(response.usage.inputTokens).toBe(800);
    expect(response.usage.outputTokens).toBe(120);
  });

  it('scenario selection is deterministic: the same request answers the same way', async () => {
    const input = renderAdaptInput(context.sent);
    const first = (await plan(input)).parsed;
    const second = (await plan(input)).parsed;
    expect(second).toEqual(first);
  });

  it('a SCENARIO token in the free text overrides the default for that request only', async () => {
    const tagged = adaptationContextFixture({ request: onlyDumbbellsRequest({ freeText: 'SCENARIO:unknown-exercise' }) });
    const override = adaptationProposalModelSchema.parse((await plan(renderAdaptInput(tagged.sent))).parsed);
    expect(override.exercises.map((e) => e.exerciseKey)).toContain('ghost_lift_9000');

    const plain = adaptationProposalModelSchema.parse((await plan(renderAdaptInput(context.sent))).parsed);
    expect(plain.exercises.map((e) => e.exerciseKey)).not.toContain('ghost_lift_9000');
  });

  it('critic-revise: the first critique asks to revise, later ones accept; the revise pass drops an accessory', async () => {
    await control('/scenario', { name: 'critic-revise' });
    const critiqueInput = renderCriticInput(
      context.sent,
      { title: 't', summary: 's', estimatedMinutes: 20, exercises: [], dropped: [], rationale: ['r'], uncertainty: [] } as never,
      { repairs: [], rejected: [], estimatedMinutes: 20, fitsRequest: true, promptVersion: 1, warnings: [] },
    );
    const first = adaptationCritiqueModelSchema.parse((await critique(critiqueInput)).parsed);
    expect(first.verdict).toBe('revise');
    expect(first.issues.some((i) => i.severity === 'major')).toBe(true);
    expect(adaptationCritiqueModelSchema.parse((await critique(critiqueInput)).parsed).verdict).toBe('accept');

    const draft = adaptationProposalModelSchema.parse((await plan(renderAdaptInput(context.sent))).parsed);
    const revised = adaptationProposalModelSchema.parse(
      (
        await plan(
          renderAdaptInput(context.sent, {
            previous: { exercises: [], estimatedMinutes: 20 },
            critique: { round: 1, verdict: 'revise', checks: { honoursRequest: false, preservesIntent: true, avoidsSoreAreas: true, sensibleOrder: true }, issues: first.issues },
          }),
        )
      ).parsed,
    );
    expect(revised.exercises.length).toBeLessThanOrEqual(draft.exercises.length);
  });

  it('over-volume asks for more sets than planned; over-time ignores the minutes', async () => {
    const planned = new Map(context.sent.today?.exercises.map((e) => [e.key, e.sets]));
    await control('/scenario', { name: 'over-volume' });
    const volume = adaptationProposalModelSchema.parse((await plan(renderAdaptInput(context.sent))).parsed);
    expect(volume.exercises.some((e) => e.sets > (planned.get(e.exerciseKey) ?? Infinity))).toBe(true);

    await control('/scenario', { name: 'over-time' });
    const time = adaptationProposalModelSchema.parse((await plan(renderAdaptInput(context.sent))).parsed);
    const availableHere = context.sent.today?.exercises.filter((e) => e.availableHere).length ?? 0;
    expect(time.exercises.length).toBe(availableHere);
  });

  it('heavy-tokens reports a large first planner call, then the scripted counts', async () => {
    await control('/scenario', { name: 'heavy-tokens' });
    const input = renderAdaptInput(context.sent);
    const first = await plan(input);
    expect((first.usage.inputTokens ?? 0) + (first.usage.outputTokens ?? 0)).toBeGreaterThanOrEqual(10_000);
    const second = await plan(input);
    expect(second.usage.inputTokens).toBe(1200);
  });

  it('malformed answers invalid JSON, which the real adapter reports as a structured-output failure', async () => {
    await control('/scenario', { name: 'malformed' });
    const failure = await plan(renderAdaptInput(context.sent)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AiError);
    expect((failure as AiError).code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
  });

  it('rate-limit answers 429 with Retry-After on the first call only', async () => {
    await control('/scenario', { name: 'rate-limit' });
    const input = renderAdaptInput(context.sent);
    const failure = await plan(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AiError);
    expect((failure as AiError).code).toBe('AI_RATE_LIMITED');
    expect((failure as AiError).retryAfterMs).toBe(2000);
    expect(adaptationProposalModelSchema.safeParse((await plan(input)).parsed).success).toBe(true);
  });

  it('the log records what was sent (schema name, scenario, text), so a test can assert what was not', async () => {
    await plan(renderAdaptInput(context.sent));
    const log = (await (await control('/log')).json()) as Array<{ schemaName: string; scenario: string; imageCount: number; text: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ schemaName: ADAPTATION_PROPOSAL_SCHEMA_NAME, scenario: 'valid', imageCount: 0 });
    expect(log[0].text).toContain(CONTEXT_JSON_OPEN);
  });

  it('refuses an unknown scenario', async () => {
    const res = await control('/scenario', { name: 'nope' });
    expect(res.status).toBe(400);
  });
});
