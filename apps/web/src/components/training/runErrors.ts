/**
 * A failed run's `errorCode` in words. AI platform codes reuse the shared
 * `aiErrorCopy` mapping; training codes have their own sentences.
 */
import { aiErrorCopy } from '../ai/AiErrorAlert';
import { TRAINING_RUN_BUDGET_EXCEEDED } from '../../services/aiErrors';
import { TOKEN_CAP_SETTINGS_PATH, tokenCapText } from '../settings/ai/aiErrorText';

export interface RunErrorCopy {
  title: string;
  body: string;
  action?: { label: string; to: string };
}

const TRAINING_COPY: Record<string, RunErrorCopy> = {
  TRAINING_RESEARCH_INSUFFICIENT: {
    title: 'Not enough reliable sources',
    body: 'The researcher could not find enough sources it could verify for this plan. Try again, or describe the goal more generally.',
  },
  TRAINING_PLAN_REJECTED: {
    title: 'The plan did not pass the checks',
    body: 'The agents could not produce a plan that passes the safety and feasibility checks. Try again, or change your answers.',
  },
  TRAINING_STALE_PLAN: {
    title: 'Your plan changed meanwhile',
    body: 'Your plan changed while the agents were working. Start again from the latest version.',
  },
  TRAINING_RUN_LOST: {
    title: 'The run was lost',
    body: 'The worker running this plan stopped several times. Try again.',
  },
  TRAINING_CONTEXT_TOO_LARGE: {
    title: 'Too much to send',
    body: 'Your context is too large for the model your administrator assigned. Try again with less to send, or ask your administrator for a model with a larger context window.',
  },
  TRAINING_ROLE_UNAVAILABLE: {
    title: 'An agent could not run',
    body: 'One of the agents no longer has a usable model.',
    action: { label: 'Check the agents', to: '/settings/ai/agents' },
  },
  TRAINING_GYM_NOT_FOUND: {
    title: 'The gym is gone',
    body: 'The gym chosen for this plan no longer exists. Choose another gym and try again.',
  },
  TRAINING_PROGRAM_NOT_FOUND: { title: 'The plan is gone', body: 'The plan to revise no longer exists.' },
  TRAINING_PROGRAM_ARCHIVED: { title: 'The plan was archived', body: 'This plan was archived while the agents were working.' },
  TRAINING_REQUEST_INVALID: { title: 'The request was not valid', body: 'Some answers could not be used. Start again.' },
  TRAINING_PROGRAMS_UNAVAILABLE: { title: 'The plan could not be saved', body: 'Try again in a moment.' },
  TRAINING_SAFETY_STOP: {
    title: 'Stopped for safety',
    body: 'Something in the request needs attention from a qualified professional before training.',
  },
  INTERNAL_ERROR: { title: 'Something went wrong', body: 'The run failed unexpectedly. Try again.' },
};

/** The run's cap, when known: the cap message then carries the numbers. */
export interface RunErrorContext {
  cap?: { limitTokens: number; usedTokens: number } | null;
}

/** "Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings." */
export function tokenCapCopy(cap?: RunErrorContext['cap']): RunErrorCopy {
  return {
    title: 'Stopped at your token limit',
    body: tokenCapText(cap),
    action: { label: 'Change the limit', to: TOKEN_CAP_SETTINGS_PATH },
  };
}

export function runErrorCopy(code: string | null | undefined, context: RunErrorContext = {}): RunErrorCopy {
  if (code === TRAINING_RUN_BUDGET_EXCEEDED) return tokenCapCopy(context.cap);
  if (code && TRAINING_COPY[code]) return TRAINING_COPY[code];
  if (code && code.startsWith('AI_')) {
    const copy = aiErrorCopy({ code, message: '' });
    return { title: copy.title, body: copy.body, ...(copy.action ? { action: copy.action } : {}) };
  }
  return { title: 'The run failed', body: 'The agents could not finish this plan. Try again.' };
}
