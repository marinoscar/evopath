import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  MEMORY_CONTENT_MIN,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCES,
} from '../memory.constants';

// =============================================================================
// /api/memories — schemas (#325; docs/specs/ai-memory.md §3)
// =============================================================================
//
// The Zod layer bounds the shape (enums, length); the content RULES (no
// instruction, URL, email, code, secret, financial, phone or third-party
// data) are applied by `MemoryService`, which answers 400
// `MEMORY_CONTENT_REJECTED` with `details.rule`.
// =============================================================================

const categorySchema = z.enum(MEMORY_CATEGORIES).meta({
  description:
    'What the memory is about: `goal`, `preference`, `constraint_injury`, `schedule`, `equipment`, ' +
    '`training_history`, `nutrition`, `coaching_style` or `other`.',
});

const sensitivitySchema = z.enum(MEMORY_SENSITIVITIES).meta({
  description:
    '`health` for health-related facts (always for `constraint_injury`; inferred from the text otherwise). ' +
    'Refused while the user\'s `memory.allowHealth` is off.',
});

const contentSchema = z
  .string()
  .trim()
  .min(MEMORY_CONTENT_MIN)
  .max(MEMORY_CONTENT_MAX)
  .meta({
    description:
      `One short fact about you, ${MEMORY_CONTENT_MIN} to ${MEMORY_CONTENT_MAX} characters, on one line ` +
      '(e.g. "Prefers to be called Bobby."). No links, email addresses, code, passwords, card or bank details, ' +
      'phone numbers, other people\'s personal details, or instructions to the coach.',
  });

export const listMemoriesQuerySchema = z.object({
  category: categorySchema.optional(),
  status: z
    .enum(['active', 'deleted'])
    .default('active')
    .meta({ description: '`active` (default), or `deleted`: soft-deleted memories still inside the undo window.' }),
});
export class ListMemoriesQueryDto extends createZodDto(listMemoriesQuerySchema) {}
export type ListMemoriesQuery = z.output<typeof listMemoriesQuerySchema>;

export const createMemorySchema = z
  .object({
    content: contentSchema,
    category: categorySchema,
    sensitivity: sensitivitySchema.optional(),
  })
  .strict();
export class CreateMemoryDto extends createZodDto(createMemorySchema) {}
export type CreateMemoryInput = z.output<typeof createMemorySchema>;

export const updateMemorySchema = z
  .object({
    content: contentSchema.optional(),
    category: categorySchema.optional(),
    pinned: z.boolean().optional().meta({ description: 'A pinned memory is always sent first and never evicted.' }),
    sensitivity: sensitivitySchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Send at least one field' });
export class UpdateMemoryDto extends createZodDto(updateMemorySchema) {}
export type UpdateMemoryInput = z.output<typeof updateMemorySchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const memoryViewSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  category: z.enum(MEMORY_CATEGORIES),
  source: z.enum(MEMORY_SOURCES).meta({
    description: '`explicit` (you asked the coach to remember it), `extracted` (the coach learned it), `user_edited` (you typed or edited it).',
  }),
  sensitivity: z.enum(MEMORY_SENSITIVITIES),
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable().meta({ description: 'When a coach or plan prompt last included it.' }),
});
export class MemoryView extends createZodDto(memoryViewSchema) {}

export const memoryListSchema = z.object({
  items: z.array(memoryViewSchema),
  settings: z
    .object({
      enabled: z.boolean(),
      autoExtract: z.boolean(),
      allowHealth: z.boolean(),
      disclosureSeenAt: z.iso.datetime().nullable(),
    })
    .meta({ description: 'Your effective `memory` settings (change them with `PATCH /api/user-settings`).' }),
  policy: z
    .object({ enabled: z.boolean(), autoExtract: z.boolean(), maxPerUser: z.number().int() })
    .meta({ description: 'The deployment-wide memory policy.' }),
  counts: z.object({
    active: z.number().int(),
    byCategory: z.record(z.enum(MEMORY_CATEGORIES), z.number().int()),
  }),
});
export class MemoryListView extends createZodDto(memoryListSchema) {}
