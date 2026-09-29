import type { DraftItem, PhotoIntake, Prisma } from '@prisma/client';
import type { z } from 'zod';

// =============================================================================
// IntakeKind — what one photo-intake flow plugs in (E3.1)
// =============================================================================
//
// The intake module is kind-agnostic: it stores photos, draft items and their
// provenance, and enforces ownership, state and the review rules. Everything
// that depends on WHAT is being captured (gym equipment, a workout, a meal)
// is one registered `IntakeKind`:
//
//   - `contextSchema` validates `PhotoIntake.context` on create (for example
//     `{ gymId }`), and `assertContext` checks it against the caller (the gym
//     belongs to them; a 404 otherwise);
//   - `valueSchema` validates every `DraftItem.value` a user adds or edits
//     (the analyzer job's own writes go through `IntakeService.replaceAiDrafts`,
//     which validates them the same way);
//   - `analyzeJobType` names the server-only `ai.*` job that reads the photos
//     (`null` = a manual-only kind; `POST /intakes/:id/analyze` refuses it);
//   - `apply` turns the accepted items into real rows, inside the transaction
//     the intake module opens, so a throw leaves the intake unapplied.
//
// A kind registers itself with `IntakeKindRegistry.register(this)` in its own
// `onModuleInit`, the idiom `JobHandlerRegistry` uses. The `kind` string is
// PERMANENT once `photo_intakes` rows carry it.
// =============================================================================

export const INTAKE_STATUSES = ['draft', 'scanning', 'ready', 'applied', 'failed'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const DRAFT_ITEM_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type DraftItemStatus = (typeof DRAFT_ITEM_STATUSES)[number];

export const DRAFT_ITEM_ORIGINS = ['ai', 'user'] as const;
export type DraftItemOrigin = (typeof DRAFT_ITEM_ORIGINS)[number];

export const DRAFT_ITEM_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type DraftItemConfidence = (typeof DRAFT_ITEM_CONFIDENCES)[number];

/** The photo cap a kind gets when it declares none. */
export const DEFAULT_INTAKE_MAX_PHOTOS = 48;

export interface IntakeApplyArgs<TContext = unknown> {
  /** The transaction the intake module opened; every write goes through it. */
  tx: Prisma.TransactionClient;
  userId: string;
  /** The intake as read inside the transaction, before it is marked `applied`. */
  intake: PhotoIntake;
  /** `intake.context`, parsed by the kind's `contextSchema`. */
  context: TContext;
  /** Every `accepted` item, in `sortOrder`. Rejected items are not passed. */
  accepted: DraftItem[];
}

export interface IntakeKind<TContext = unknown, TValue = unknown> {
  /** Permanent once rows exist, e.g. `'gym_equipment'`. */
  readonly kind: string;
  /** Validates `PhotoIntake.context`. A kind without context uses `z.undefined()` or an optional schema. */
  readonly contextSchema: z.ZodType<TContext>;
  /** Validates `DraftItem.value` on create and edit. */
  readonly valueSchema: z.ZodType<TValue>;
  /** The job that analyzes the photos, e.g. `'ai.equipment.scan'`; `null` = manual-only kind. */
  readonly analyzeJobType: string | null;
  /** The most photos one intake may hold. Default 48. */
  readonly maxPhotos?: number;
  /**
   * Allowed `DraftItem.kind` values. Omitted = any non-empty string. A kind
   * with one item kind declares it so a typo is a 400 rather than a row.
   */
  readonly itemKinds?: readonly string[];
  /** Checks the context against the caller (e.g. the gym is theirs); throw a 404 otherwise. */
  assertContext?(userId: string, context: TContext): Promise<void>;
  /** Recomputes derived fields of a value before it is stored. */
  normalizeValue?(value: TValue, context: TContext): TValue | Promise<TValue>;
  /** Writes the accepted items as real data; the return value is the `apply` route's response. */
  apply(args: IntakeApplyArgs<TContext>): Promise<unknown>;
}

/** What an analyzer job hands `IntakeService.replaceAiDrafts`, one per item the model returned. */
export interface AiDraftInput {
  /** The item kind inside the intake kind, e.g. `'equipment'`. */
  kind: string;
  /** Validated by the kind's `valueSchema` (and `normalizeValue`) before it is stored. */
  value: unknown;
  confidence: DraftItemConfidence;
  uncertain?: boolean;
  uncertaintyNote?: string | null;
  /** Storage object ids of the photos the item was read from. */
  sourcePhotoIds?: string[];
}
