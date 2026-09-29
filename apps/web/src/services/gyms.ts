/**
 * The gyms API (`/api/gyms`, `/api/equipment-types`, `/api/capabilities`), as
 * the web app sees it. E3.3.
 *
 * Every route is owner-scoped on the server (`gyms:read` / `gyms:write`); a
 * foreign id answers `404`. `services/api.ts` stays the transport (bearer
 * token, refresh, the `{ data }` envelope); this module holds the calls next to
 * the types they produce.
 *
 * Photo bytes never pass through these routes: the browser uploads through
 * `POST /api/storage/objects` (`storage:write`), waits for the object to be
 * `ready`, then attaches it with `POST /gyms/:id/photos`. It views a photo
 * through a signed URL from `GET /api/storage/objects/:id/download`.
 *
 * The browser presents and collects only. The bounds below mirror the API's
 * Zod schemas so the form can explain a problem before the round trip; the API
 * decides.
 */

import { api, ApiError } from './api';
import { uploadStorageObjectAndWait, type WaitForReadyOptions } from './storage';

// -----------------------------------------------------------------------------
// Vocabulary and bounds (mirrors apps/api/src/gyms/dto)
// -----------------------------------------------------------------------------

/** Mirrors the Prisma `GymType` enum. */
export const GYM_TYPES = ['home', 'club', 'office', 'hotel', 'apartment', 'outdoor', 'other'] as const;
export type GymType = (typeof GYM_TYPES)[number];

export const GYM_TYPE_LABEL: Record<GymType, string> = {
  home: 'Home',
  club: 'Club',
  office: 'Office',
  hotel: 'Hotel',
  apartment: 'Apartment',
  outdoor: 'Outdoor',
  other: 'Other',
};

/** Mirrors the `EquipmentType.category` vocabulary, in display order. */
export const EQUIPMENT_CATEGORIES = [
  'free_weights',
  'benches_racks',
  'plate_loaded',
  'selectorized',
  'cable',
  'cardio',
  'bodyweight',
  'accessories',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_CATEGORY_LABEL: Record<EquipmentCategory, string> = {
  free_weights: 'Free weights',
  benches_racks: 'Benches and racks',
  plate_loaded: 'Plate loaded',
  selectorized: 'Selectorized',
  cable: 'Cable',
  cardio: 'Cardio',
  bodyweight: 'Bodyweight',
  accessories: 'Accessories',
};

/** A label for any category string, including one this build does not know. */
export function categoryLabel(category: string): string {
  return (EQUIPMENT_CATEGORY_LABEL as Record<string, string>)[category] ?? category.replace(/_/g, ' ');
}

export const GYM_NAME_MAX = 80;
export const GYM_DESCRIPTION_MAX = 1000;
export const GYM_NOTES_MAX = 4000;
export const EQUIPMENT_QUANTITY_MIN = 1;
export const EQUIPMENT_QUANTITY_MAX = 99;
export const EQUIPMENT_BRAND_MAX = 60;
export const EQUIPMENT_MODEL_MAX = 80;
export const EQUIPMENT_NOTES_MAX = 1000;
export const EQUIPMENT_TYPE_NAME_MAX = 80;
export const EQUIPMENT_TYPE_CAPABILITIES_MAX = 12;
export const EQUIPMENT_TYPES_LIMIT_MAX = 200;
export const GYM_PHOTOS_MAX = 100;
export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;
/** `accuracyMeters` bounds on `PUT /gyms/:id/location` (echoed, never stored). */
export const LOCATION_ACCURACY_MAX = 100000;
export const PHOTO_CAPTION_MAX = 500;
/** Client-side upload cap for a gym photo (the API refuses more). */
export const GYM_PHOTO_MAX_BYTES = 20 * 1024 * 1024;
/** Image types the API accepts as a gym photo. */
export const GYM_PHOTO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Clamp a quantity into the API's 1..99 range (non-numbers become 1). */
export function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return EQUIPMENT_QUANTITY_MIN;
  return Math.min(EQUIPMENT_QUANTITY_MAX, Math.max(EQUIPMENT_QUANTITY_MIN, Math.round(value)));
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CapabilityRef {
  id: string;
  slug: string;
  name: string;
}

/** `GET /capabilities`. */
export interface Capability {
  id: string;
  slug: string;
  name: string;
  movementPattern: string;
  primaryMuscles: string[];
  description: string | null;
}

/** One entry of `GET /equipment-types` (catalog or the caller's custom type). */
export interface EquipmentType {
  id: string;
  slug: string;
  name: string;
  category: string;
  aliases: string[];
  description: string | null;
  /** True for the caller's own custom type; false for a catalog type. */
  isCustom: boolean;
  capabilities: CapabilityRef[];
}

/** The equipment type as embedded in a gym's equipment row. */
export type GymEquipmentTypeRef = Pick<EquipmentType, 'id' | 'slug' | 'name' | 'category' | 'isCustom' | 'capabilities'>;

export type EquipmentOrigin = 'manual' | 'ai';
export type EquipmentConfidence = 'high' | 'medium' | 'low';

/** One row of a gym's equipment list. */
export interface GymEquipment {
  id: string;
  gymId: string;
  equipmentTypeId: string;
  quantity: number;
  brand: string | null;
  model: string | null;
  notes: string | null;
  origin: EquipmentOrigin;
  confidence: EquipmentConfidence | null;
  userVerified: boolean;
  /** For an AI row the user edited: the draft as the AI proposed it; else null. */
  originalAiValue: unknown;
  createdAt: string;
  updatedAt: string;
  equipmentType: GymEquipmentTypeRef;
}

export interface GymPhoto {
  id: string;
  gymId: string;
  storageObjectId: string;
  caption: string | null;
  takenAt: string | null;
  createdAt: string;
  equipmentIds: string[];
}

interface GymBase {
  id: string;
  name: string;
  type: GymType;
  description: string | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  isTemporary: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One item of `GET /gyms`. */
export interface GymSummary extends GymBase {
  equipmentCount: number;
  photoCount: number;
  /** The oldest gym photo, or null. */
  coverPhotoId: string | null;
  /** The storage object behind `coverPhotoId`, for the thumbnail. */
  coverStorageObjectId: string | null;
}

/** `GET /gyms/:id`. */
export interface GymDetail extends GymBase {
  equipment: GymEquipment[];
  photos: GymPhoto[];
}

export interface GymInput {
  name: string;
  type: GymType;
  description?: string | null;
  notes?: string | null;
  isTemporary?: boolean;
  /** Set together with `longitude`, or both omitted/null (E3.5). */
  latitude?: number | null;
  longitude?: number | null;
}

export type GymUpdate = Partial<GymInput>;

export interface EquipmentInput {
  equipmentTypeId: string;
  quantity?: number;
  brand?: string | null;
  model?: string | null;
  notes?: string | null;
}

export type EquipmentUpdate = Partial<EquipmentInput>;

export interface PhotoInput {
  storageObjectId: string;
  caption?: string | null;
  takenAt?: string | null;
  equipmentIds?: string[];
}

export interface PhotoUpdate {
  caption?: string | null;
  takenAt?: string | null;
  equipmentIds?: string[];
}

export interface EquipmentTypeQuery {
  q?: string;
  category?: string;
  limit?: number;
}

export interface CustomEquipmentTypeInput {
  name: string;
  category: string;
  capabilityIds?: string[];
}

// -----------------------------------------------------------------------------
// Gyms
// -----------------------------------------------------------------------------

const gymPath = (id: string) => `/gyms/${encodeURIComponent(id)}`;

/** `GET /gyms` (`gyms:read`): default first, then by name. */
export function listGyms(options: { includeTemporary?: boolean } = {}): Promise<GymSummary[]> {
  const query = options.includeTemporary === false ? '?includeTemporary=false' : '';
  return api.get<GymSummary[]>(`/gyms${query}`);
}

/** `POST /gyms` (`gyms:write`). The first gym of a user becomes the default. */
export function createGym(input: GymInput): Promise<GymDetail> {
  return api.post<GymDetail>('/gyms', input);
}

/** `GET /gyms/:id` (`gyms:read`). */
export function getGym(id: string): Promise<GymDetail> {
  return api.get<GymDetail>(gymPath(id));
}

/** `PATCH /gyms/:id` (`gyms:write`). */
export function updateGym(id: string, input: GymUpdate): Promise<GymDetail> {
  return api.patch<GymDetail>(gymPath(id), input);
}

/** `DELETE /gyms/:id` (`gyms:write`); also deletes the gym's photos. */
export async function deleteGym(id: string): Promise<void> {
  await api.delete<void>(gymPath(id));
}

/** `POST /gyms/:id/default` (`gyms:write`). */
export function setDefaultGym(id: string): Promise<GymDetail> {
  return api.post<GymDetail>(`${gymPath(id)}/default`);
}

/** `PUT /gyms/:id/location` body (E3.5). */
export interface GymLocationInput {
  latitude: number;
  longitude: number;
  /** Only echoed back by the API; never stored or logged. */
  accuracyMeters?: number;
}

/**
 * `PUT /gyms/:id/location` (`gyms:write`): set the gym's position. The API
 * rounds both values to 5 decimals (about 1 m).
 */
export async function setGymLocation(id: string, input: GymLocationInput): Promise<void> {
  await api.put<unknown>(`${gymPath(id)}/location`, input);
}

/** `DELETE /gyms/:id/location` (`gyms:write`): clear both coordinates. */
export async function clearGymLocation(id: string): Promise<void> {
  await api.delete<void>(`${gymPath(id)}/location`);
}

// -----------------------------------------------------------------------------
// Equipment
// -----------------------------------------------------------------------------

const equipmentPath = (gymId: string, equipmentId: string) =>
  `${gymPath(gymId)}/equipment/${encodeURIComponent(equipmentId)}`;

export function listGymEquipment(gymId: string): Promise<GymEquipment[]> {
  return api.get<GymEquipment[]>(`${gymPath(gymId)}/equipment`);
}

/** `POST /gyms/:id/equipment`: `origin: 'manual'`, `userVerified: true`. */
export function addGymEquipment(gymId: string, input: EquipmentInput): Promise<GymEquipment> {
  return api.post<GymEquipment>(`${gymPath(gymId)}/equipment`, input);
}

export function updateGymEquipment(
  gymId: string,
  equipmentId: string,
  input: EquipmentUpdate,
): Promise<GymEquipment> {
  return api.patch<GymEquipment>(equipmentPath(gymId, equipmentId), input);
}

export async function deleteGymEquipment(gymId: string, equipmentId: string): Promise<void> {
  await api.delete<void>(equipmentPath(gymId, equipmentId));
}

// -----------------------------------------------------------------------------
// Photos
// -----------------------------------------------------------------------------

const photoPath = (gymId: string, photoId: string) =>
  `${gymPath(gymId)}/photos/${encodeURIComponent(photoId)}`;

export function listGymPhotos(gymId: string): Promise<GymPhoto[]> {
  return api.get<GymPhoto[]>(`${gymPath(gymId)}/photos`);
}

/** `POST /gyms/:id/photos`: the storage object must be the caller's, `ready`, an image. */
export function attachGymPhoto(gymId: string, input: PhotoInput): Promise<GymPhoto> {
  return api.post<GymPhoto>(`${gymPath(gymId)}/photos`, input);
}

export function updateGymPhoto(gymId: string, photoId: string, input: PhotoUpdate): Promise<GymPhoto> {
  return api.patch<GymPhoto>(photoPath(gymId, photoId), input);
}

/** `DELETE /gyms/:id/photos/:pid`: removes the link and the storage object. */
export async function deleteGymPhoto(gymId: string, photoId: string): Promise<void> {
  await api.delete<void>(photoPath(gymId, photoId));
}

/**
 * Why a picked file cannot be a gym photo, or `null` when it can go on to be
 * prepared (downscaled) and uploaded.
 */
export function gymPhotoRejection(file: File): string | null {
  if (!file.type.startsWith('image/')) return `${file.name} is not an image.`;
  if (file.size > GYM_PHOTO_MAX_BYTES) return `${file.name} is larger than 20 MiB.`;
  return null;
}

/** Why a prepared file cannot be uploaded (a type the API refuses), or `null`. */
export function gymPhotoTypeRejection(file: File): string | null {
  if ((GYM_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) return null;
  return `${file.name} cannot be used here. Convert it to JPEG or PNG.`;
}

/** Upload a photo through the storage API, wait for `ready`, then attach it. */
export async function uploadGymPhoto(
  gymId: string,
  file: File,
  options?: WaitForReadyOptions,
): Promise<GymPhoto> {
  const object = await uploadStorageObjectAndWait(file, options);
  return attachGymPhoto(gymId, { storageObjectId: object.id });
}

// -----------------------------------------------------------------------------
// Equipment types and capabilities
// -----------------------------------------------------------------------------

/** `GET /equipment-types`: the catalog plus the caller's custom types. */
export function listEquipmentTypes(query: EquipmentTypeQuery = {}): Promise<EquipmentType[]> {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.category) params.set('category', query.category);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return api.get<EquipmentType[]>(`/equipment-types${qs ? `?${qs}` : ''}`);
}

/** `POST /equipment-types`: a custom type owned by the caller. */
export function createEquipmentType(input: CustomEquipmentTypeInput): Promise<EquipmentType> {
  return api.post<EquipmentType>('/equipment-types', input);
}

export function updateEquipmentType(
  id: string,
  input: Partial<CustomEquipmentTypeInput>,
): Promise<EquipmentType> {
  return api.patch<EquipmentType>(`/equipment-types/${encodeURIComponent(id)}`, input);
}

/** Refused with `409 EQUIPMENT_TYPE_IN_USE` while any gym uses it. */
export async function deleteEquipmentType(id: string): Promise<void> {
  await api.delete<void>(`/equipment-types/${encodeURIComponent(id)}`);
}

/** `GET /capabilities`. */
export function listCapabilities(): Promise<Capability[]> {
  return api.get<Capability[]>('/capabilities');
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** The message to show for a failed call. */
export function gymErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export const GYMS_UNAVAILABLE = 'Gyms are not available for your account.';
export const PHOTOS_UNAVAILABLE =
  'Adding photos needs permission to upload files, which your account does not have.';
