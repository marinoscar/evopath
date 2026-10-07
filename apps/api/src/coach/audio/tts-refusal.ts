import type { CoachAudioFailureReason } from '../../app-metrics/domain-metrics.service';

// =============================================================================
// Speech-run outcome and refusal detection (E7.6, #246; spec §2.7)
// =============================================================================
//
// PURE. Maps one `ai.audio.speech` run (as `ai_runs` stores it) to what the
// coach message's audio becomes:
//
//   succeeded, a real audio object          -> ready
//   succeeded, empty or tiny audio          -> failed, refusal
//   succeeded, no usable output              -> failed, provider_error
//   failed, a refusal (content filter, or
//     refusal wording in the error)          -> failed, refusal
//   failed or cancelled otherwise            -> failed, provider_error
//   still pending/running at the wait cap    -> failed, timeout
//   still pending/running, job failed        -> failed, provider_error
//   still pending/running otherwise          -> wait (the wait cap decides)
//   no run at all                            -> failed, provider_error
//
// OpenAI's speech model sometimes declines profane input; a refusal is
// recorded and NEVER retried or rephrased (spec §2.14). Only the error code
// and a bounded check of the error message are read; the text spoken is
// never inspected or logged here.
// =============================================================================

/** Below this many bytes a "successful" speech file is treated as a refusal (silence or a stub). */
export const COACH_MIN_SPEECH_BYTES = 1_024;

/** Error wording that reads as the provider declining the input. */
const REFUSAL_PATTERN =
  /\b(refus\w*|declin\w*|content[ _-]?(policy|filter\w*)|moderation|safety system|not (able|allowed) to|can(?:not|'t) (help|comply|assist))\b/i;

export type CoachAudioCause = 'settled' | 'timeout';

/** The parts of an `ai_runs` row the classification reads. */
export interface SpeechRunSnapshot {
  status: string;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export type SpeechRunOutcome =
  | { kind: 'ready'; storageObjectId: string; voice: string | null; mimeType: string; size: number }
  | { kind: 'failed'; reason: CoachAudioFailureReason; code: string | null }
  | { kind: 'wait' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a failed run's error says the provider refused the script. */
export function isTtsRefusal(errorCode: string | null | undefined, errorMessage: string | null | undefined): boolean {
  if (errorCode === 'AI_CONTENT_FILTERED') return true;
  return typeof errorMessage === 'string' && REFUSAL_PATTERN.test(errorMessage.slice(0, 500));
}

export function classifySpeechRun(
  run: SpeechRunSnapshot | null,
  context: { cause: CoachAudioCause; jobSucceeded?: boolean | null },
): SpeechRunOutcome {
  if (!run) return { kind: 'failed', reason: 'provider_error', code: null };

  switch (run.status) {
    case 'succeeded':
      return classifyOutput(run.output);
    case 'failed':
      return {
        kind: 'failed',
        reason: isTtsRefusal(run.errorCode, run.errorMessage) ? 'refusal' : 'provider_error',
        code: run.errorCode,
      };
    case 'cancelled':
      return { kind: 'failed', reason: context.cause === 'timeout' ? 'timeout' : 'provider_error', code: run.errorCode };
    default:
      // pending / running
      if (context.cause === 'timeout') return { kind: 'failed', reason: 'timeout', code: null };
      if (context.jobSucceeded === false) return { kind: 'failed', reason: 'provider_error', code: run.errorCode };
      return { kind: 'wait' };
  }
}

function classifyOutput(output: unknown): SpeechRunOutcome {
  if (!output || typeof output !== 'object') return { kind: 'failed', reason: 'provider_error', code: null };
  const o = output as Record<string, unknown>;

  if (o.type !== 'speech' || typeof o.storageObjectId !== 'string' || !UUID.test(o.storageObjectId)) {
    return { kind: 'failed', reason: 'provider_error', code: null };
  }

  const mimeType = typeof o.mimeType === 'string' ? o.mimeType : '';
  if (!mimeType.toLowerCase().startsWith('audio/')) return { kind: 'failed', reason: 'provider_error', code: null };

  const size = typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 0;
  if (size < COACH_MIN_SPEECH_BYTES) return { kind: 'failed', reason: 'refusal', code: null };

  return {
    kind: 'ready',
    storageObjectId: o.storageObjectId,
    voice: typeof o.voice === 'string' ? o.voice : null,
    mimeType,
    size,
  };
}
