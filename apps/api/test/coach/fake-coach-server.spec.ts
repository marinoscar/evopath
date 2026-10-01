// =============================================================================
// The fake AI servers' AI Coach answers (E7.13)
// =============================================================================
//
// `tests/e2e/support/fake-vision-server.mjs` (nudge, weekly review, chat tool
// loop) and `fake-responses-server.mjs` (speech) are what the coach e2e runs
// against. This suite starts both as child processes on ephemeral ports and
// proves, against the REAL content guard, that every canned line passes it
// under the plain register, the supportive register and a locked screen, that
// the chat loop copies its figures from the tool result, and that the speech
// route answers a real-sized MP3 or the failure the mode asks for.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { COACH_TEXT_FIELDS, guardCoachText, type CoachTextField } from '../../src/coach/guard/coach-content-guard';
import { COACH_MIN_SPEECH_BYTES } from '../../src/coach/audio/tts-refusal';
import { COACH_MOMENTS } from '../../src/coach/personas';
import { WEEKLY_REVIEW_LIMITS, coachWeeklyReviewSchema } from '../../src/coach/review/weekly-review-schema';
import { coachNudgeSchema } from '../../src/coach/nudges/nudge-schema';

const SUPPORT = join(__dirname, '..', '..', '..', '..', 'tests', 'e2e', 'support');

async function start(script: string, env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn(process.execPath, [join(SUPPORT, script)], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening on :(\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`${script} exited with ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

const json = { 'content-type': 'application/json', authorization: 'Bearer sk-fake-e2e-0000' };

describe('fake AI servers: AI Coach answers', () => {
  let vision: { child: ChildProcess; base: string };
  let responses: { child: ChildProcess; base: string };

  beforeAll(async () => {
    vision = await start('fake-vision-server.mjs');
    responses = await start('fake-responses-server.mjs');
  }, 30_000);
  afterAll(() => {
    vision?.child.kill();
    responses?.child.kill();
  });
  beforeEach(async () => {
    await fetch(`${vision.base}/__control/reset`, { method: 'POST' });
    await fetch(`${responses.base}/__control/reset`, { method: 'POST' });
  });

  async function complete(body: Record<string, unknown>) {
    const res = await fetch(`${vision.base}/v1/chat/completions`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> };
  }

  const structured = (name: string, userText: string) => ({
    model: 'fake-coach',
    messages: [{ role: 'user', content: userText }],
    response_format: { type: 'json_schema', json_schema: { name, schema: {}, strict: true } },
  });

  const guardContexts = [
    { label: 'plain', supportive: false, lockScreenSafe: true },
    { label: 'supportive', supportive: true, lockScreenSafe: true },
  ];

  it('lists fake-coach', async () => {
    const res = await fetch(`${vision.base}/v1/models`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('fake-coach');
  });

  describe.each(COACH_MOMENTS.map((moment) => [moment]))('nudge for %s', (moment) => {
    it('answers a schema-valid message the content guard accepts in every register', async () => {
      const text = `COACH CONTEXT (JSON data):\n${JSON.stringify({ moment })}\n\n<<<USER_WHY\n(none)\nUSER_WHY>>>`;
      const answer = await complete(structured('coach_nudge', text));
      const out = coachNudgeSchema.parse(JSON.parse(answer.choices[0].message.content!));
      expect(out.send).toBe(true);
      expect(out.moment).toBe(moment);

      for (const ctx of guardContexts) {
        for (const personaId of ['coach', 'drill_sergeant', 'nana']) {
          for (const field of COACH_TEXT_FIELDS) {
            const violations = guardCoachText(field as CoachTextField, out[field], {
              personaId,
              intensity: 2,
              register: { profane: false },
              lockScreenSafe: ctx.lockScreenSafe,
              allowedNumbers: [],
              supportive: ctx.supportive,
              surface: 'app',
            });
            expect({ moment, ctx: ctx.label, personaId, field, violations }).toEqual({ moment, ctx: ctx.label, personaId, field, violations: [] });
          }
        }
      }
    });
  });

  it('asks the three kickoff questions', async () => {
    const text = `COACH CONTEXT (JSON data):\n${JSON.stringify({ moment: 'kickoff' })}`;
    const out = JSON.parse((await complete(structured('coach_nudge', text))).choices[0].message.content!);
    expect(out.body).toMatch(/when/i);
    expect(out.body).toMatch(/where/i);
    expect(out.body).toMatch(/fallback/i);
  });

  it('declines on request, except a kickoff, and reset restores sending', async () => {
    await fetch(`${vision.base}/__control/coach`, { method: 'POST', body: JSON.stringify({ nudge: 'decline' }) });
    const ctx = (moment: string) => `COACH CONTEXT (JSON data):\n${JSON.stringify({ moment })}`;
    const declined = JSON.parse((await complete(structured('coach_nudge', ctx('missed_twice')))).choices[0].message.content!);
    expect(declined).toMatchObject({ send: false, title: '', body: '' });
    expect(coachNudgeSchema.safeParse(declined).success).toBe(true);
    const kickoff = JSON.parse((await complete(structured('coach_nudge', ctx('kickoff')))).choices[0].message.content!);
    expect(kickoff.send).toBe(true);

    await fetch(`${vision.base}/__control/reset`, { method: 'POST' });
    const again = JSON.parse((await complete(structured('coach_nudge', ctx('missed_twice')))).choices[0].message.content!);
    expect(again.send).toBe(true);
  });

  it('rejects an unknown coach mode', async () => {
    const res = await fetch(`${vision.base}/__control/coach`, { method: 'POST', body: JSON.stringify({ speech: 'explode' }) });
    expect(res.status).toBe(400);
  });

  it('answers a schema-valid weekly review the guard accepts as an email', async () => {
    const answer = await complete(structured('coach_weekly_review', 'Write the review.'));
    const out = coachWeeklyReviewSchema.parse(JSON.parse(answer.choices[0].message.content!));
    expect(out.wins.length).toBeGreaterThan(0);
    expect(out.headline.length).toBeLessThanOrEqual(WEEKLY_REVIEW_LIMITS.headline);
    for (const [field, text] of [['title', out.headline], ['body', out.intro], ['body', out.focus]] as const) {
      expect(guardCoachText(field, text, { personaId: 'coach', intensity: 2, register: { profane: false }, lockScreenSafe: false, allowedNumbers: [], surface: 'email' })).toEqual([]);
    }
  });

  describe('chat', () => {
    const tools = [{ type: 'function', function: { name: 'get_training_signals', parameters: { type: 'object', properties: {} } } }];
    const ask = (text: string) => ({ model: 'fake-coach', tools, messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: text }] });

    it('calls get_training_signals for a progress question, then answers with the tool result figures', async () => {
      const first = await complete(ask('How am I doing?'));
      expect(first.choices[0].finish_reason).toBe('tool_calls');
      expect(first.choices[0].message.tool_calls![0].function.name).toBe('get_training_signals');

      const result = JSON.stringify({ adherence: { totals: { planned: 7, completed: 5 } } });
      const second = await complete({
        ...ask('How am I doing?'),
        messages: [...ask('How am I doing?').messages, { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', tool_call_id: 'call_fake_signals', content: result }],
      });
      const text = second.choices[0].message.content!;
      expect(second.choices[0].finish_reason).toBe('stop');
      expect(text).toContain('5 of 7');
      expect(
        guardCoachText('body', text, { personaId: 'coach', intensity: 2, register: { profane: false }, lockScreenSafe: false, allowedNumbers: ['5', '7'], supportive: false, surface: 'app' }),
      ).toEqual([]);
    });

    it('answers directly, with no tool call, when the question is not about progress', async () => {
      const answer = await complete(ask('Can we talk about Thursday?'));
      expect(answer.choices[0].finish_reason).toBe('stop');
      expect(answer.choices[0].message.tool_calls).toBeUndefined();
      expect(answer.choices[0].message.content).toBeTruthy();
    });

    it('answers without a figure when the tool result has no adherence totals', async () => {
      const answer = await complete({ ...ask('How am I doing?'), messages: [...ask('How am I doing?').messages, { role: 'tool', content: '{}' }] });
      expect(answer.choices[0].message.content).not.toMatch(/\d/);
    });
  });

  describe.each([
    ['vision', () => vision.base, '/__control/coach', (mode: string) => ({ speech: mode })],
    ['responses', () => responses.base, '/__control/speech', (mode: string) => ({ mode })],
  ] as const)('speech on the %s server', (_name, base, controlPath, controlBody) => {
    const speak = () =>
      fetch(`${base()}/v1/audio/speech`, { method: 'POST', headers: json, body: JSON.stringify({ model: 'fake-tts', input: 'Hello', voice: 'alloy' }) });

    it('returns a real-sized MPEG audio stream', async () => {
      const res = await speak();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(COACH_MIN_SPEECH_BYTES);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1] & 0xe0).toBe(0xe0);
    });

    it('fails on request', async () => {
      await fetch(`${base()}${controlPath}`, { method: 'POST', body: JSON.stringify(controlBody('fail')) });
      expect((await speak()).status).toBe(500);
    });

    it('refuses on request, in wording the coach reads as a refusal', async () => {
      await fetch(`${base()}${controlPath}`, { method: 'POST', body: JSON.stringify(controlBody('refuse')) });
      const res = await speak();
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/declined/);
    });
  });

  it('the responses server refuses speech without a key', async () => {
    const res = await fetch(`${responses.base}/v1/audio/speech`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
