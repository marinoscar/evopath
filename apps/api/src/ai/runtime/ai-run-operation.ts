// =============================================================================
// Which operation a background run carries (issues #437, #438, #439)
// =============================================================================
//
// Every background run is one `ai_runs` row; `request.operation` says what it
// is, and so which job type executes it:
//
//   (absent)           a responses run       ai.response.run
//   'images.generate'  an image generation   ai.image.generate   (#437)
//   'images.edit'      an image edit         ai.image.generate   (#437)
//   'audio.transcribe' a transcription       ai.audio.transcribe (#438)
//   'audio.speech'     speech synthesis      ai.audio.speech     (#439)
//
// A request with no (or an unknown) `operation` is a responses run — every
// row written before #437 reads exactly as it did.
// =============================================================================

import { AI_SPEECH_OPERATION, AI_TRANSCRIBE_OPERATION } from './ai-audio-run-request';
import { AI_IMAGE_OPERATIONS, type AiImageOperation } from './ai-image-run-request';

/** Every operation a run can carry. */
export type AiRunOperation =
  | 'responses'
  | AiImageOperation
  | typeof AI_TRANSCRIBE_OPERATION
  | typeof AI_SPEECH_OPERATION;

const MEDIA_OPERATIONS: readonly AiRunOperation[] = [
  ...AI_IMAGE_OPERATIONS,
  AI_TRANSCRIBE_OPERATION,
  AI_SPEECH_OPERATION,
];

/** Which operation a stored run request carries. A request without one is a responses run. */
export function aiRunOperation(request: unknown): AiRunOperation {
  const operation = (request as { operation?: unknown } | null)?.operation;

  return (MEDIA_OPERATIONS as readonly unknown[]).includes(operation) ? (operation as AiRunOperation) : 'responses';
}
