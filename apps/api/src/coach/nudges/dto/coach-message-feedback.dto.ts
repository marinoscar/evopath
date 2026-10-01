import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `POST /api/coach/messages/:id/feedback` body (E7.5). `null` clears the thumbs. STRICT. */
export const coachMessageFeedbackSchema = z
  .object({
    feedback: z.enum(['up', 'down']).nullable().meta({ description: 'Thumbs up or down; `null` clears it.' }),
  })
  .strict();

export class CoachMessageFeedbackDto extends createZodDto(coachMessageFeedbackSchema) {}
