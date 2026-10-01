import { SAFETY_STOP_GUIDANCE } from '../../training-agents/guardrails/safety-keywords';
import { screenFreeText } from '../../training-agents/guardrails/safety-screen';
import { screenDistress } from '../safety/distress-screen';

// =============================================================================
// The chat's safety outcome (E7.7, #247; docs/specs/ai-coach.md §2.9, §2.14)
// =============================================================================
//
// Every user chat message passes BOTH screens; the outcome decides the turn:
//
//   blocked       `screenFreeText` found an urgent physical symptom, or the
//                 distress screen found a self-harm, suicidal-ideation or
//                 disordered-eating cue. NO model call; the persona is
//                 dropped; the reply is fixed text: `SAFETY_STOP_GUIDANCE`
//                 for a symptom, `COACH_DISTRESS_REPLY` for distress
//                 (distress wins when both match: it is the more urgent).
//   conservative  a pain, injury or strain stem. The model IS called, in the
//                 supportive register (calm, no pushy angle, no profanity,
//                 never "train through pain").
//   ok            the persona as configured.
//
// `screen` names which screen fired (`distress`, `symptom`, `pain`) for the
// `safety` SSE frame and `app.coach.chat.safety_hits{screen}`; `reasons` are
// rule codes, never the user's words.
// =============================================================================

export type CoachChatSafetyLevel = 'ok' | 'conservative' | 'blocked';

export type CoachChatSafetyScreen = 'distress' | 'symptom' | 'pain';

export interface CoachChatSafety {
  level: CoachChatSafetyLevel;
  /** Which screen fired; null for `ok`. */
  screen: CoachChatSafetyScreen | null;
  /** Rule codes (`distress:self_harm`, `urgent:chest_pain`, `stem:pain`), sorted. Never user text. */
  reasons: string[];
}

/**
 * The fixed, reviewed reply to a distress cue. Deliberately free of digits (no
 * country-specific number: the deployment's users may be anywhere), of
 * profanity and of any persona voice. It points to a person, a professional
 * and the local emergency number or a crisis line, and leaves the door open.
 */
export const COACH_DISTRESS_REPLY =
  "I'm really glad you told me, and I'm taking it seriously. I'm a training coach, so I'm not the right help for " +
  'this, but you deserve support from a person right now. Please reach out to someone you trust, or to a doctor or ' +
  'a mental health professional. If you are in danger or thinking about ending your life, call your local emergency ' +
  'number or a crisis line now; if you can, tell someone near you. Training can wait. When you are ready to talk ' +
  "about it, I'm still here.";

/** The reply to an urgent physical symptom: the training agents' stop guidance, unchanged. */
export const COACH_SYMPTOM_REPLY = SAFETY_STOP_GUIDANCE;

/** Screens one chat message. Pure. */
export function screenCoachChat(text: string): CoachChatSafety {
  const distress = screenDistress([text]);
  const physical = screenFreeText([text]);

  if (distress.hit) {
    const reasons = [...distress.codes, ...(physical.level === 'blocked' ? physical.reasons : [])].sort();
    return { level: 'blocked', screen: 'distress', reasons };
  }
  if (physical.level === 'blocked') return { level: 'blocked', screen: 'symptom', reasons: physical.reasons };
  if (physical.level === 'conservative') return { level: 'conservative', screen: 'pain', reasons: physical.reasons };
  return { level: 'ok', screen: null, reasons: [] };
}

/** The deterministic reply for a `blocked` outcome. */
export function blockedReplyFor(safety: CoachChatSafety): string {
  return safety.screen === 'distress' ? COACH_DISTRESS_REPLY : COACH_SYMPTOM_REPLY;
}
