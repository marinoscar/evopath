/**
 * The chat composer's attachments — issue #445 (API #441).
 *
 * "Attach image" is offered only when the selected model reads images
 * (`vision_input` + the `image` input modality) and "Attach file" only when it
 * reads files (`file_input` + `file`) — capability-driven, never by model
 * name. Chosen files are held here as `File`s and shown as removable chips;
 * the page uploads them when the turn is sent. A file the selected model
 * cannot read (after a model switch, say) or that is over the size cap is
 * shown as an error chip with the reason spelled out below, and blocks
 * sending until it is removed.
 */
import type { ChangeEvent } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { AttachFile as AttachFileIcon, Image as ImageIcon } from '@mui/icons-material';
import type { UsableAiModel } from '../../services/ai';
import { AiAttachmentChips } from './AiAttachmentChips';
import {
  AI_CHAT_ATTACHMENTS_MAX,
  AI_CHAT_IMAGE_MIME_TYPES,
  attachableKinds,
  attachmentKind,
  attachmentProblem,
} from './playground/chatAttachments';

export interface PendingAttachment {
  key: string;
  file: File;
}

let sequence = 0;
/** Wrap chosen files with a stable key each. */
export function toPendingAttachments(files: FileList | File[] | null | undefined): PendingAttachment[] {
  return Array.from(files ?? []).map((file) => {
    sequence += 1;
    return { key: `att-${sequence}`, file };
  });
}

/** Everything that blocks sending the pending attachments, or `[]`. */
export function pendingAttachmentProblems(
  pending: readonly PendingAttachment[],
  model: UsableAiModel | null | undefined,
): string[] {
  const problems = pending.flatMap((item) => {
    const problem = attachmentProblem(item.file, model);
    return problem ? [`${item.file.name}: ${problem}`] : [];
  });
  if (pending.length > AI_CHAT_ATTACHMENTS_MAX) problems.push(`At most ${AI_CHAT_ATTACHMENTS_MAX} attachments per message`);
  return problems;
}

export interface AiChatAttachmentPickerProps {
  model: UsableAiModel | null;
  pending: PendingAttachment[];
  onAdd: (items: PendingAttachment[]) => void;
  onRemove: (key: string) => void;
  disabled?: boolean;
}

/** The attach buttons; render {@link AiChatPendingAttachments} for the chips. */
export function AiChatAttachButtons({ model, onAdd, disabled }: Pick<AiChatAttachmentPickerProps, 'model' | 'onAdd' | 'disabled'>) {
  const kinds = attachableKinds(model);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const added = toPendingAttachments(event.target.files);
    // Let the same file be chosen again after it is removed.
    event.target.value = '';
    if (added.length) onAdd(added);
  };

  return (
    <>
      {kinds.image && (
        <Button component="label" size="small" color="inherit" startIcon={<ImageIcon />} disabled={disabled}>
          Attach image
          <input
            hidden
            multiple
            type="file"
            aria-label="Attach image"
            accept={AI_CHAT_IMAGE_MIME_TYPES.join(',')}
            onChange={onChange}
          />
        </Button>
      )}
      {kinds.file && (
        <Button component="label" size="small" color="inherit" startIcon={<AttachFileIcon />} disabled={disabled}>
          Attach file
          <input hidden multiple type="file" aria-label="Attach file" onChange={onChange} />
        </Button>
      )}
    </>
  );
}

/** The pending chips and, when any, what blocks sending them. */
export function AiChatPendingAttachments({ model, pending, onRemove, disabled }: Omit<AiChatAttachmentPickerProps, 'onAdd'>) {
  if (pending.length === 0) return null;
  const problems = pendingAttachmentProblems(pending, model);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
      <AiAttachmentChips
        label="Attachments to send"
        disabled={disabled}
        onRemove={onRemove}
        items={pending.map((item) => ({
          key: item.key,
          name: item.file.name,
          size: item.file.size,
          kind: attachmentKind(item.file.type),
          problem: attachmentProblem(item.file, model),
        }))}
      />
      {problems.length > 0 && (
        <Box role="alert">
          {problems.map((problem) => (
            <Typography key={problem} variant="caption" color="error" component="p">
              {problem}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}
