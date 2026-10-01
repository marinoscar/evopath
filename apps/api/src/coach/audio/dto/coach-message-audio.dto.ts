import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { COACH_AUDIO_STATUSES } from '../../chat/dto/coach-chat.dto';

// =============================================================================
// GET|POST /api/coach/messages/:id/audio (#259; docs/specs/ai-coach.md §3.6)
// =============================================================================
//
// One shape for both routes, so the client can poll either. Fields beyond
// `status` appear only when they mean something: `storageObjectId` and `voice`
// once `ready`, `runId` while `pending`.
// =============================================================================

export const coachMessageAudioSchema = z.object({
  status: z.enum(COACH_AUDIO_STATUSES).meta({
    description:
      '`none` (never spoken, or purged), `pending` (a speech run is in flight), `ready` (play `storageObjectId`), ' +
      '`failed` (the last attempt failed; POST again to retry).',
  }),
  storageObjectId: z.uuid().optional().meta({
    description: 'Only while `ready`: the audio, downloaded with `GET /api/storage/objects/{id}/download`.',
  }),
  runId: z.uuid().optional().meta({
    description: 'Only while `pending`: poll `GET /api/ai/runs/{runId}`, or this message\'s `GET .../audio`.',
  }),
  voice: z.string().optional().meta({ description: 'Only while `ready`: the voice the audio was spoken in.' }),
});

export type CoachMessageAudio = z.infer<typeof coachMessageAudioSchema>;
export class CoachMessageAudioDto extends createZodDto(coachMessageAudioSchema) {}
