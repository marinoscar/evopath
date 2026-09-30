/**
 * A failed run's `errorCode` in words. AI platform codes reuse the shared
 * `aiErrorCopy` mapping; training codes have their own sentences.
 */
import { aiErrorCopy } from '../ai/AiErrorAlert';

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
  TRAINING_RUN_BUDGET_EXCEEDED: {
    title: 'The token cap was reached',
    body: 'The run used its whole token cap before the plan was finished. Raise the cap, or try again.',
    action: { label: 'Change the cap', to: '/settings/ai/agents' },
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
    body: 'Your context is too large for the chosen model. Choose a model with a larger context window.',
    action: { label: 'Choose a model', to: '/settings/ai/agents' },
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

export function runErrorCopy(code: string | null | undefined): RunErrorCopy {
  if (code && TRAINING_COPY[code]) return TRAINING_COPY[code];
  if (code && code.startsWith('AI_')) {
    const copy = aiErrorCopy({ code, message: '' });
    return { title: copy.title, body: copy.body, ...(copy.action ? { action: copy.action } : {}) };
  }
  return { title: 'The run failed', body: 'The agents could not finish this plan. Try again.' };
}
