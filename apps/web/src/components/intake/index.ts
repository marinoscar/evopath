/**
 * The photo-intake kit: pick/capture photos, disclose where they go, review
 * the AI draft. Every photo-first flow imports from here and supplies only
 * its own `renderValue` / `renderEditor`.
 */
export {
  ImageIntake,
  STAGE_LABEL,
  IMAGE_ACCEPT,
  IMAGE_OR_PDF_ACCEPT,
  ADD_PHOTOS_LABEL,
  ADD_PHOTOS_OR_PDFS_LABEL,
  PdfTileFace,
  type ImageIntakeProps,
} from './ImageIntake';
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
  RetainFilesControl,
  RETAIN_FILES_LABEL,
  RETAIN_FILES_HELPER_TEXT,
  type RetainFilesControlProps,
} from './RetainFilesControl';

export {
  useImageIntake,
  IMAGE_INTAKE_CONCURRENCY,
  IMAGE_INTAKE_DEFAULT_MAX_PHOTOS,
  INTAKE_PDF_MAX_BYTES,
  isPdfFile,
  isPdfName,
  type IntakeFileKind,
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
  intakeFileErrorMessage,
  isHealthIntakeKind,
  HEALTH_INTAKE_KINDS,
  type FileRetention,
  type DraftItemView,
  type PhotoIntakeView,
  type PhotoIntakePhotoView,
  type PhotoIntakeStatus,
  type PhotoIntakeSummary,
  type DraftItemConfidence,
} from '../../services/intake';
