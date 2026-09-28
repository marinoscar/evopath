/**
 * Chat attachments — issue #445 (API: #441, docs/specs/ai-platform.md §2.9).
 *
 * A chat turn may carry the caller's own storage objects as `image`/`file`
 * content parts, named by `storageObjectId`. The rules mirror the API's
 * (`apps/api/src/ai/core/types/file-inputs.types.ts`) so a request the API
 * would refuse is caught before anything is uploaded:
 *
 * - MODALITY FOLLOWS THE MIME TYPE, not the button used: PNG/JPEG/GIF/WebP is
 *   an image and needs `vision_input`; anything else is a file and needs
 *   `file_input` — each in the model's `capabilities` AND `inputModalities`.
 * - Images at most 20 MiB, files at most 50 MiB, at most 16 per request.
 *
 * The API re-checks all of it; these checks exist so the user learns before
 * waiting for an upload, not instead of the server's answer.
 */
import type { AiContentPart, AiInputItem, UsableAiModel } from '../../../services/ai';
import type { AiErrorInfo } from '../../../services/aiErrors';

export const AI_CHAT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** The largest image a chat turn may reference (20 MiB). */
export const AI_CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** The largest non-image file a chat turn may reference (50 MiB). */
export const AI_CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** The most attachments one turn may carry. */
export const AI_CHAT_ATTACHMENTS_MAX = 16;

export type AiAttachmentKind = 'image' | 'file';

/** An attachment once uploaded — what a sent message remembers. */
export interface AiChatAttachment {
  storageObjectId: string;
  name: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  kind: AiAttachmentKind;
}

/** The kind a file is sent as, decided by its MIME type (the API's rule). */
export function attachmentKind(mimeType: string): AiAttachmentKind {
  const normalised = mimeType.split(';')[0].trim().toLowerCase();
  return (AI_CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(normalised) ? 'image' : 'file';
}

function hasInput(model: UsableAiModel | null | undefined, capability: string, modality: string): boolean {
  if (!model) return false;
  return (
    model.capabilities.capabilities.includes(capability) && model.capabilities.inputModalities.includes(modality)
  );
}

/** Which kinds `model` can read — capability AND input modality, as the API requires. */
export function attachableKinds(model: UsableAiModel | null | undefined): Record<AiAttachmentKind, boolean> {
  return {
    image: hasInput(model, 'vision_input', 'image'),
    file: hasInput(model, 'file_input', 'file'),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why `file` cannot be attached for `model`, or `null` when it can. */
export function attachmentProblem(file: File, model: UsableAiModel | null | undefined): string | null {
  const kind = attachmentKind(file.type);
  if (!attachableKinds(model)[kind]) {
    return kind === 'image' ? "This model can't read images" : "This model can't read files";
  }
  const max = kind === 'image' ? AI_CHAT_IMAGE_MAX_BYTES : AI_CHAT_FILE_MAX_BYTES;
  if (file.size > max) return `${kind === 'image' ? 'Images' : 'Files'} must be ${formatBytes(max)} or smaller`;
  return null;
}

/** The content part for one uploaded attachment. */
export function attachmentPart(attachment: AiChatAttachment): AiContentPart {
  return attachment.kind === 'image'
    ? { type: 'image', storageObjectId: attachment.storageObjectId }
    : { type: 'file', storageObjectId: attachment.storageObjectId, filename: attachment.name };
}

/**
 * The request `input` for a turn: the plain prompt string when nothing is
 * attached (unchanged from #434), otherwise one user message with the text
 * first and each attachment after it.
 */
export function chatTurnInput(text: string, attachments: readonly AiChatAttachment[]): string | AiInputItem[] {
  if (attachments.length === 0) return text;
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text }, ...attachments.map(attachmentPart)],
    },
  ];
}

/**
 * A failed turn that carried attachments, explained. The API answers an
 * attachment that no longer exists with a plain 404, and one that is not
 * the caller's with a plain 403 (the storage API's own answers, §2.9) —
 * neither carries an AI code, so without this they would read as a generic
 * failure. Everything else passes through unchanged.
 */
export function withAttachmentContext(error: AiErrorInfo, hadAttachments: boolean): AiErrorInfo {
  if (!hadAttachments || error.code !== null) return error;
  if (error.status === 404) {
    return { ...error, message: 'An attached file could not be found. It may have been deleted — attach it again.' };
  }
  if (error.status === 403) {
    return { ...error, message: 'You do not have access to one of the attached files.' };
  }
  return error;
}
