import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/coach/state (E7.4): the `/coach` header
// =============================================================================

const count = z.number().int().min(0);

export const coachStateViewSchema = z.object({
  enabled: z.boolean().meta({ description: 'The coach is on for the caller: AI, the system coach switch and `coach.enabled`.' }),
  pausedUntil: z.iso.datetime().nullable().meta({ description: 'The coach is paused until this instant.' }),
  silencedAt: z.iso
    .datetime()
    .nullable()
    .meta({ description: 'The coach stepped back at this instant (ignored nudges or inactivity) until the caller re-engages.' }),
  weeklyTarget: z
    .object({
      done: count.meta({ description: 'Planned sessions of the current ISO week that are done (partial included).' }),
      planned: count.meta({ description: 'Planned sessions in the current ISO week.' }),
    })
    .meta({ description: 'The weekly target ring, from the training signals.' }),
  weeklyStreak: count.meta({ description: 'Consecutive finished weeks at or above the target.' }),
  streakPassesLeft: count.meta({ description: 'Passes that keep the streak through one missed week.' }),
  nextSession: z
    .object({
      date: z.iso.date().meta({ description: 'Local day of the session.' }),
      name: z.string(),
      programWorkoutId: z.uuid(),
    })
    .nullable()
    .meta({ description: 'The next planned session not done yet, from today on; null when none in the next 7 days.' }),
  unreadCount: count.meta({ description: 'Delivered coach messages the caller has not opened.' }),
  chatClearedAt: z.iso
    .datetime()
    .nullable()
    .meta({
      description:
        'When the caller last started the chat over (`POST /api/coach/chat/clear`); the timeline lists only messages after it. Null: never.',
    }),
});

export type CoachStateView = z.infer<typeof coachStateViewSchema>;

export class CoachStateViewDto extends createZodDto(coachStateViewSchema) {}
