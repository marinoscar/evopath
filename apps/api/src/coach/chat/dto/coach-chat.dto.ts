import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Coach chat and timeline DTOs (E7.7, #247; docs/specs/ai-coach.md §2.9)
// =============================================================================

/** The longest chat message a user may send (spec E7.7: cost bound). */
export const COACH_CHAT_TEXT_MAX = 2000;

export const COACH_TIMELINE_LIMIT_DEFAULT = 30;
export const COACH_TIMELINE_LIMIT_MAX = 50;

export const coachChatRequestSchema = z
  .object({
    text: z
      .string()
      .max(COACH_CHAT_TEXT_MAX)
      .refine((value) => value.trim().length > 0, { message: 'text must not be empty' })
      .meta({ description: `The user's message, 1 to ${COACH_CHAT_TEXT_MAX} characters.` }),
  })
  .strict();

export class CoachChatRequestDto extends createZodDto(coachChatRequestSchema) {}
export type CoachChatRequest = z.output<typeof coachChatRequestSchema>;

export const coachTimelineQuerySchema = z
  .object({
    before: z.uuid().optional().meta({
      description: 'A message id from an earlier page (its `nextCursor`): return the messages older than it.',
    }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COACH_TIMELINE_LIMIT_MAX)
      .default(COACH_TIMELINE_LIMIT_DEFAULT)
      .meta({ description: `Page size, 1 to ${COACH_TIMELINE_LIMIT_MAX} (default ${COACH_TIMELINE_LIMIT_DEFAULT}).` }),
  })
  .strict();

export class CoachTimelineQueryDto extends createZodDto(coachTimelineQuerySchema) {}
export type CoachTimelineQuery = z.output<typeof coachTimelineQuerySchema>;

export const COACH_MESSAGE_ROLES = ['coach', 'user'] as const;
export const COACH_AUDIO_STATUSES = ['none', 'pending', 'ready', 'failed'] as const;

export const coachTimelineItemSchema = z.object({
  id: z.uuid().meta({ description: 'The message id; the deep link is `/coach?m=<id>`.' }),
  role: z.enum(COACH_MESSAGE_ROLES),
  kind: z.string().meta({
    description: '`nudge`, `chat`, `weekly_review`, `celebration`, `photo_prompt`, `comeback`, `kickoff` or `system`.',
  }),
  moment: z.string().nullable().meta({ description: 'The trigger of a coach-initiated message; null for chat.' }),
  personaId: z.string().nullable().meta({ description: 'The persona at send time; null for user turns and safety replies.' }),
  intensity: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  audioStatus: z.enum(COACH_AUDIO_STATUSES),
  audioStorageObjectId: z.uuid().nullable().meta({
    description: 'The spoken version, only while `audioStatus` is `ready`; download through the storage routes.',
  }),
  voice: z.string().nullable().meta({ description: 'The voice of the audio when it is ready (`data.voice`), else null.' }),
  feedback: z.enum(['up', 'down']).nullable(),
  openedAt: z.iso.datetime().nullable(),
  data: z.unknown().nullable().meta({
    description:
      'Kind-specific data: review stats; for a chat reply `{ links?, pausedUntil?, safety?, fallback? }`.',
  }),
  createdAt: z.iso.datetime(),
});

export type CoachTimelineItem = z.infer<typeof coachTimelineItemSchema>;

export const coachTimelinePageSchema = z.object({
  items: z.array(coachTimelineItemSchema).meta({ description: 'Newest first.' }),
  nextCursor: z.uuid().nullable().meta({ description: 'Pass as `before` for the next (older) page; null on the last page.' }),
});

export class CoachTimelinePageView extends createZodDto(coachTimelinePageSchema) {}
export type CoachTimelinePage = z.infer<typeof coachTimelinePageSchema>;
