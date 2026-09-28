/**
 * Attachment chips — issue #445 (chat attachments, API #441).
 *
 * Used twice: in the composer, where each chip can be removed before the
 * turn is sent (a file the selected model cannot read is shown as an error,
 * the reason in its tooltip and its accessible name),
 * and in a sent user message, where the chips record what went with it.
 */
import { Box, Chip, IconButton, Tooltip } from '@mui/material';
import {
  Cancel as CancelIcon,
  Description as FileIcon,
  ErrorOutlined as ErrorIcon,
  Image as ImageIcon,
} from '@mui/icons-material';
import { formatBytes, type AiAttachmentKind } from './playground/chatAttachments';

export interface AiAttachmentChipItem {
  key: string;
  name: string;
  size: number;
  kind: AiAttachmentKind;
  /** Why it cannot be sent; the chip is shown as an error. */
  problem?: string | null;
}

export interface AiAttachmentChipsProps {
  items: AiAttachmentChipItem[];
  /** Present in the composer: each chip gets a remove button. */
  onRemove?: (key: string) => void;
  disabled?: boolean;
  /** `contrast` for chips on the primary-coloured user bubble. */
  tone?: 'default' | 'contrast';
  label?: string;
}

export function AiAttachmentChips({ items, onRemove, disabled, tone = 'default', label = 'Attachments' }: AiAttachmentChipsProps) {
  if (items.length === 0) return null;
  return (
    <Box role="list" aria-label={label} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, minWidth: 0 }}>
      {items.map((item) => {
        const icon = item.problem ? <ErrorIcon /> : item.kind === 'image' ? <ImageIcon /> : <FileIcon />;
        const chip = (
          <Chip
            size="small"
            icon={icon}
            color={item.problem ? 'error' : 'default'}
            variant={item.problem ? 'outlined' : 'filled'}
            label={`${item.name} · ${formatBytes(item.size)}`}
            aria-label={`${item.name}, ${formatBytes(item.size)}${item.problem ? `: ${item.problem}` : ''}`}
            sx={{
              maxWidth: '100%',
              ...(tone === 'contrast'
                ? { bgcolor: 'rgba(255,255,255,0.18)', color: 'inherit', '& .MuiChip-icon': { color: 'inherit' } }
                : {}),
            }}
          />
        );
        return (
          <Box
            role="listitem"
            key={item.key}
            sx={{ minWidth: 0, maxWidth: '100%', display: 'inline-flex', alignItems: 'center' }}
          >
            {item.problem ? (
              <Tooltip title={item.problem} describeChild>
                {chip}
              </Tooltip>
            ) : (
              chip
            )}
            {/* A real button, not the chip's delete icon: keyboard-reachable and named. */}
            {onRemove && (
              <IconButton
                size="small"
                aria-label={`Remove ${item.name}`}
                disabled={disabled}
                onClick={() => onRemove(item.key)}
                sx={{ ml: -0.25 }}
              >
                <CancelIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export default AiAttachmentChips;
