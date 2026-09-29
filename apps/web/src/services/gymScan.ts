/**
 * "Scan gym" (E3.4): the `gym_equipment` photo-intake kind, as the web app
 * sees it.
 *
 * The scan is an ordinary photo intake (`services/intake.ts`): the photos go
 * to `/api/intakes`, a server-only `ai.equipment.scan` job drafts the
 * equipment, the user reviews the draft, and `POST /intakes/:id/apply` writes
 * the accepted items to the gym. Nothing here decides anything: the API
 * validates every value against the kind's schema (and recomputes the derived
 * `capabilitySlugs` / `targetMuscles` for a catalog item), enforces ownership
 * of the gym, and merges an item into an identical existing row.
 *
 * The value type mirrors the kind's `valueSchema`
 * (`apps/api/src/gyms/intake/gym-equipment.intake-kind.ts`); the bounds below
 * mirror its Zod bounds so the editor can explain a problem before the round
 * trip.
 */
import {
  createIntake,
  listIntakes,
  type PhotoIntakeView,
} from './intake';

/** The registered intake kind (permanent once rows exist). */
export const GYM_EQUIPMENT_INTAKE_KIND = 'gym_equipment';
/** The draft-item kind inside it. */
export const EQUIPMENT_DRAFT_ITEM_KIND = 'equipment';
/** `PhotoIntake.subjectType` for a scan of one gym. */
export const GYM_SCAN_SUBJECT_TYPE = 'gym';
/** Photos one scan may hold (the kind's `maxPhotos`). */
export const GYM_SCAN_MAX_PHOTOS = 48;

export const EQUIPMENT_DRAFT_NAME_MAX = 80;
export const EQUIPMENT_DRAFT_BRAND_MAX = 60;
export const EQUIPMENT_DRAFT_MODEL_MAX = 80;
export const EQUIPMENT_DRAFT_CONFIGURATION_MAX = 60;
export const EQUIPMENT_DRAFT_NOTES_MAX = 1000;

/** One draft item's value (the kind's `valueSchema`). */
export interface EquipmentValue {
  /** Catalog slug, the slug of one of the caller's custom types, or `null` for an unidentified ("other") item. */
  equipmentTypeSlug: string | null;
  /** 1..80: the catalog name, or the free-text name of an "other" item. */
  name: string;
  /** Integer 1..99. */
  quantity: number;
  quantityUncertain: boolean;
  brand: string | null;
  /** What made the AI say that brand, e.g. "MATRIX lettering on the frame". */
  brandEvidence: string | null;
  model: string | null;
  /** E.g. "seated, selectorized". */
  configuration: string | null;
  /** The user's own free text. */
  notes: string | null;
  capabilitySlugs: string[];
  /** Derived by the server; informational. */
  targetMuscles: string[];
}

/** The starting value for "Add missing item". */
export const EMPTY_EQUIPMENT_VALUE: EquipmentValue = Object.freeze({
  equipmentTypeSlug: null,
  name: '',
  quantity: 1,
  quantityUncertain: false,
  brand: null,
  brandEvidence: null,
  model: null,
  configuration: null,
  notes: null,
  capabilitySlugs: [],
  targetMuscles: [],
}) as EquipmentValue;

/** The scan's `PhotoIntake.context`. */
export interface GymScanContext {
  gymId: string;
}

/** A batch of photos the model could not read (`resultMeta.failedChunks`). */
export interface EquipmentScanFailedChunk {
  /** 0-based batch number. */
  index: number;
  code: string;
  /** 0-based photo positions (intake order) the batch covered, inclusive. */
  firstPhotoIndex?: number;
  lastPhotoIndex?: number;
}

/** What the scan job records in `resultMeta`. Every field is optional on read. */
export interface EquipmentScanResultMeta {
  promptVersion?: number;
  chunks?: number;
  photoCount?: number;
  ignoredObjects?: string[];
  failedChunks?: EquipmentScanFailedChunk[];
}

/** `POST /intakes/:id/apply` for this kind. */
export interface GymEquipmentApplyResult {
  created: number;
  merged: number;
  photosAttached: number;
  /** Photos not attached because the gym already holds its maximum (100). */
  photosSkipped?: number;
  gymId: string;
}

/** Navigation state the scan page hands to the gym page (`/gyms/:gymId`). */
export interface GymDetailLocationState {
  /** Open the manual equipment picker ("Continue manually"). */
  openPicker?: boolean;
  /** A one-off message, e.g. the apply summary. */
  flash?: string;
}

export type GymScanIntake = PhotoIntakeView<EquipmentValue, GymScanContext>;

/** Read `resultMeta` defensively: it is JSON the job wrote, not a typed column. */
export function scanResultMeta(intake: Pick<PhotoIntakeView, 'resultMeta'> | null): EquipmentScanResultMeta {
  const meta = intake?.resultMeta;
  if (!meta || typeof meta !== 'object') return {};
  const raw = meta as Record<string, unknown>;
  const failed = Array.isArray(raw.failedChunks)
    ? raw.failedChunks.filter(
        (entry): entry is EquipmentScanFailedChunk =>
          typeof entry === 'object' && entry !== null && typeof (entry as { index?: unknown }).index === 'number',
      )
    : [];
  return {
    promptVersion: typeof raw.promptVersion === 'number' ? raw.promptVersion : undefined,
    chunks: typeof raw.chunks === 'number' ? raw.chunks : undefined,
    photoCount: typeof raw.photoCount === 'number' ? raw.photoCount : undefined,
    ignoredObjects: Array.isArray(raw.ignoredObjects)
      ? raw.ignoredObjects.filter((entry): entry is string => typeof entry === 'string')
      : [],
    failedChunks: failed,
  };
}

/**
 * The newest unfinished scan of this gym (`draft`, `scanning` or `ready`), or
 * a new one. Resuming keeps a reload or a slow job from losing the review.
 */
export async function startOrResumeGymScan(gymId: string): Promise<string> {
  const open = await listIntakes({
    kind: GYM_EQUIPMENT_INTAKE_KIND,
    subjectId: gymId,
    status: ['draft', 'scanning', 'ready'],
    limit: 1,
  });
  if (open.length > 0) return open[0].id;
  const created = await createIntake<GymScanContext>({
    kind: GYM_EQUIPMENT_INTAKE_KIND,
    context: { gymId },
    subjectType: GYM_SCAN_SUBJECT_TYPE,
    subjectId: gymId,
  });
  return created.id;
}

/** "3 added, 1 already there. Photos saved to this gym." */
export function applySummary(
  result: Pick<GymEquipmentApplyResult, 'created' | 'merged' | 'photosAttached' | 'photosSkipped'>,
): string {
  const parts = [`${result.created} added`];
  if (result.merged > 0) parts.push(`${result.merged} already there`);
  let text = `${parts.join(', ')}.`;
  if (result.photosAttached > 0) text += ' Photos saved to this gym.';
  const skipped = result.photosSkipped ?? 0;
  if (skipped > 0) {
    text += ` ${skipped} ${skipped === 1 ? 'photo was' : 'photos were'} not saved: the gym is full.`;
  }
  return text;
}

/**
 * "Photos 17-20" for a failed batch: from the batch's own photo positions
 * when the job recorded them, else from its index and the photo count.
 */
export function failedChunkRange(chunk: EquipmentScanFailedChunk, photoCount: number, perRequest = 16): string {
  let first: number;
  let last: number;
  if (typeof chunk.firstPhotoIndex === 'number' && typeof chunk.lastPhotoIndex === 'number') {
    first = chunk.firstPhotoIndex + 1;
    last = Math.max(first, chunk.lastPhotoIndex + 1);
  } else {
    first = chunk.index * perRequest + 1;
    last = Math.max(first, Math.min((chunk.index + 1) * perRequest, photoCount || (chunk.index + 1) * perRequest));
  }
  return first === last ? `Photo ${first}` : `Photos ${first}-${last}`;
}

/** `leg_curl` -> "Leg curl" (slugs are stable API strings; this is display only). */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

/** The helper text under the scan's photo picker. */
export const SCAN_PHOTOS_HELPER =
  'Take several photos of the room, and close-ups of labels and placards for better results. Up to 16 photos per request; more are sent in batches.';

/** "1:05" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
