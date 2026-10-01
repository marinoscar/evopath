// =============================================================================
// Progress photo domain events (EventEmitter2)
// =============================================================================
//
// `progress_photo.created` is emitted by `ProgressPhotosService.create` AFTER
// the `progress_photos` row is written (there is no surrounding transaction),
// once per created photo. The payload is IDS ONLY: never the storage key, a
// URL, the pose or the note, so a listener (the coach's conversion
// attribution, E7.5) learns that a photo exists and nothing about it.
//
// The constant lives here, in the photo module, so the photo module imports
// no coach code (`test/coach/coach-photo-privacy.spec.ts`); the coach imports
// it from here. EventEmitter2 dispatches synchronously: a listener must return
// quickly and never throw. Treat the key as permanent: listeners subscribe by
// string.
// =============================================================================

export const PROGRESS_PHOTO_CREATED_EVENT = 'progress_photo.created';

export interface ProgressPhotoCreatedEvent {
  userId: string;
  photoId: string;
}
