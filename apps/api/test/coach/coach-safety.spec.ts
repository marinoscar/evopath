import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { buildCoachChatInstructions } from '../../src/coach/chat/coach-chat-prompt';
import {
  COACH_DISTRESS_REPLY,
  COACH_SYMPTOM_REPLY,
  blockedReplyFor,
  screenCoachChat,
} from '../../src/coach/chat/coach-chat-safety';
import { CoachChatService, type CoachChatEvent } from '../../src/coach/chat/coach-chat.service';
import { containsProfanity, guardCoachText } from '../../src/coach/guard/coach-content-guard';
import { COACH_PERSONA_IDS } from '../../src/coach/personas';
import { renderPersonaStyle } from '../../src/coach/personas/resolve-register';
import { SAFETY_STOP_GUIDANCE } from '../../src/training-agents/guardrails/safety-keywords';

// =============================================================================
// Coach safety (E7.7, #247; docs/specs/ai-coach.md §2.14) — guardrail suite
// =============================================================================
//
// 1. A blocked (urgent symptom) or distress message makes NO model call, for
//    every persona and intensity, Sarge L3 unlocked included, and gets the
//    fixed reply.
// 2. A conservative (pain) message runs the supportive register: no persona
//    flavour, no profanity, never "train through pain".
// 3. The fixed replies are clean: no profanity, no figures, a seek-help line.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';

const DISTRESS_FIXTURES = [
  'I want to kill myself',
  'sometimes I think about ending my life',
  "I've been cutting myself",
  'I make myself throw up after meals',
  'I am starving myself to make weight',
  'self harm',
];

const SYMPTOM_FIXTURES = ['I get chest pain on the stairs', 'I fainted during my last set'];

const PAIN_FIXTURES = ['my shoulder hurts', 'I think I strained my hamstring', 'my knee is sore'];

function serviceWith(coach: Record<string, unknown>, policy: Record<string, unknown>) {
  const runTools = jest.fn(() => {
    throw new Error('the model must not be called');
  });
  const resolve = jest.fn();
  const prisma = {
    coachMessage: { create: jest.fn(async () => ({ id: 'm', createdAt: new Date() })) },
    coachState: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const service = new CoachChatService(
    prisma as never,
    { forUser: () => ({ runTools }) } as never,
    { resolve } as never,
    { getSettings: async () => ({ coach }) } as never,
    { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, ...policy }) } as never,
    { get: async () => ({ dateOfBirth: '1990-05-05' }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { turn: jest.fn(), safetyHit: jest.fn(), toolCall: jest.fn(), error: jest.fn() } as never,
    { coachGuardRejection: jest.fn() } as never,
  );
  return { service, runTools, resolve, prisma };
}

async function drain(iterable: AsyncIterable<CoachChatEvent>): Promise<CoachChatEvent[]> {
  const out: CoachChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('coach chat safety (E7.7)', () => {
  describe('screen outcome', () => {
    it.each(DISTRESS_FIXTURES)('distress is blocked: "%s"', (text) => {
      expect(screenCoachChat(text)).toMatchObject({ level: 'blocked', screen: 'distress' });
    });

    it.each(SYMPTOM_FIXTURES)('an urgent symptom is blocked: "%s"', (text) => {
      expect(screenCoachChat(text)).toMatchObject({ level: 'blocked', screen: 'symptom' });
    });

    it.each(PAIN_FIXTURES)('pain is conservative: "%s"', (text) => {
      expect(screenCoachChat(text)).toMatchObject({ level: 'conservative', screen: 'pain' });
    });

    it('distress wins over a symptom in the same message', () => {
      const outcome = screenCoachChat('I have chest pain and I want to die');
      expect(outcome.screen).toBe('distress');
      expect(blockedReplyFor(outcome)).toBe(COACH_DISTRESS_REPLY);
    });

    it('an ordinary question is ok', () => {
      expect(screenCoachChat('How many sets should I do today?')).toEqual({ level: 'ok', screen: null, reasons: [] });
    });

    it('reasons are rule codes, never the user text', () => {
      const outcome = screenCoachChat('I want to kill myself, my knee hurts');
      for (const reason of outcome.reasons) expect(reason).toMatch(/^(distress|urgent|stem):[a-z_]+$/);
    });
  });

  describe('fixed replies', () => {
    it.each([
      ['distress', COACH_DISTRESS_REPLY],
      ['symptom', COACH_SYMPTOM_REPLY],
    ])('%s: no profanity, no figures, a seek-help line', (_name, reply) => {
      expect(containsProfanity(reply)).toBe(false);
      expect(reply).not.toMatch(/\d/);
      expect(reply).toMatch(/professional|medical care/);
      expect(reply).toMatch(/emergency number/);
    });

    it('the symptom reply is SAFETY_STOP_GUIDANCE', () => {
      expect(COACH_SYMPTOM_REPLY).toBe(SAFETY_STOP_GUIDANCE);
    });
  });

  describe('no model call on blocked or distress, for every persona and intensity', () => {
    const cases = COACH_PERSONA_IDS.flatMap((personaId) =>
      ([1, 2, 3] as const).map((intensity) => ({ personaId, intensity })),
    );

    it.each(cases)('$personaId L$intensity (profanity unlocked where possible)', async ({ personaId, intensity }) => {
      for (const text of [...DISTRESS_FIXTURES, ...SYMPTOM_FIXTURES]) {
        const t = serviceWith(
          { enabled: true, personaId, intensity, profanity: true, adultConfirmedAt: '2026-01-01T00:00:00.000Z' },
          { allowProfanePersonas: true },
        );
        const events = await drain(await t.service.startTurn(USER, text));

        expect(t.runTools).not.toHaveBeenCalled();
        expect(t.resolve).not.toHaveBeenCalled();
        expect(events[0]).toMatchObject({ type: 'safety', level: 'blocked' });
        const reply = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
        expect(containsProfanity(reply)).toBe(false);
        // Persona dropped on the stored reply.
        const coachRow = (t.prisma.coachMessage.create.mock.calls as unknown as Array<[{ data: any }]>)
          .map((c) => c[0].data)
          .find((d) => d.role === 'coach');
        expect(coachRow).toMatchObject({ personaId: null, intensity: null });
      }
    });
  });

  describe('supportive register', () => {
    const unlocked = { profane: true, reason: null } as const;

    it.each(COACH_PERSONA_IDS)('%s: the supportive prompt drops the persona, profanity and pushy framing', (personaId) => {
      const style = renderPersonaStyle(personaId, 3, unlocked);
      const prompt = buildCoachChatInstructions({ style, supportive: true, today: '2026-10-01' });
      expect(prompt).toContain('REGISTER: SUPPORTIVE');
      expect(prompt).not.toContain('PERSONA:');
      expect(prompt).not.toContain('adult language is allowed');
      expect(prompt).toContain('Never advise training through pain');
      expect(containsProfanity(prompt)).toBe(false);
    });

    it('the guard rejects challenge phrasing and profanity in the supportive register, even for an unlocked Sarge L3', () => {
      const ctx = {
        personaId: 'drill_sergeant',
        intensity: 3,
        register: { profane: false },
        lockScreenSafe: false,
        allowedNumbers: [],
        supportive: true,
      };
      const reasons = (text: string) => guardCoachText('body', text, ctx).map((v) => v.reason);
      expect(reasons('No excuses, push through the pain, recruit!')).toContain('supportive_register');
      expect(reasons('Rest that knee, damn it.')).toContain('profanity');
      expect(reasons('Rest that knee today. A gentle walk is fine if it does not hurt.')).toEqual([]);
    });
  });
});
