/**
 * The photo-intake kit: pick/capture photos, disclose where they go, review
 * the AI draft. Every photo-first flow imports from here and supplies only
 * its own `renderValue` / `renderEditor`.
 */
export { ImageIntake, STAGE_LABEL, type ImageIntakeProps } from './ImageIntake';
export { AiDraftReview, type AiDraftReviewProps } from './AiDraftReview';
export { DraftItemRow, provenanceLabel, type DraftItemRowProps, type DraftItemEditorProps } from './DraftItemRow';
export { ConfidenceBadge, type ConfidenceBadgeProps } from './ConfidenceBadge';
export {
  AiVisionDisclosure,
  AI_VISION_MAX_IMAGES_PER_REQUEST,
  visionRequestCount,
  type AiVisionDisclosureProps,
} from './AiVisionDisclosure';
export { NoVisionModelNotice, type NoVisionModelNoticeProps, type NoVisionReason } from './NoVisionModelNotice';
export { StoragePhotoThumb, type StoragePhotoThumbProps } from './StoragePhotoThumb';

export {
  useImageIntake,
  IMAGE_INTAKE_CONCURRENCY,
  IMAGE_INTAKE_DEFAULT_MAX_PHOTOS,
  type IntakePhotoStage,
  type IntakePhotoState,
  type UseImageIntakeOptions,
  type UseImageIntakeReturn,
} from '../../hooks/useImageIntake';
export {
  useVisionAvailability,
  useRefreshOnFeatureRefusal,
  visionStatusOf,
  type VisionAvailabilityStatus,
  type VisionModel,
  type UseVisionAvailabilityReturn,
} from '../../hooks/useVisionAvailability';
export {
  visionNoticeCopy,
  visionShortReason,
  AI_ASSIGNMENTS_PATH,
  type VisionNoticeCopy,
} from './visionAvailabilityCopy';
export { usePhotoIntake, type UsePhotoIntakeOptions, type UsePhotoIntakeReturn } from '../../hooks/usePhotoIntake';
export { downscaleImage, UnsupportedImageError, type DownscaleImageOptions } from '../../utils/downscaleImage';
export {
  uploadAndAttach,
  detachFrom,
  type DraftItemView,
  type PhotoIntakeView,
  type PhotoIntakePhotoView,
  type PhotoIntakeStatus,
  type PhotoIntakeSummary,
  type DraftItemConfidence,
} from '../../services/intake';
