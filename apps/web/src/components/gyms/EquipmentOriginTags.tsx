/**
 * Where a piece of equipment came from: "Added by you" for a manual row;
 * "From photo scan" for a row a scan drafted (E3.4), with "AI guess" and the
 * scan's confidence until the owner verified it, "You verified" afterwards,
 * and, when the owner changed what the AI proposed, an "AI said…" chip that
 * opens the original value (`originalAiValue`).
 * Always text, never colour alone.
 */
import { useId, useState, type MouseEvent } from 'react';
import { Box, Chip, Popover, Stack, Typography } from '@mui/material';
import { ConfidenceBadge } from '../intake/ConfidenceBadge';
import type { GymEquipment } from '../../services/gyms';

type TagItem = Pick<GymEquipment, 'origin' | 'userVerified' | 'confidence'> &
  Partial<Pick<GymEquipment, 'originalAiValue' | 'equipmentTypeId' | 'equipmentType'>>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * "Elliptical ×3, Precor" — what the AI proposed, read from `originalAiValue`.
 * The value is JSON the server stored (`{ equipmentTypeId, quantity, brand,
 * model, notes }`, optionally with `name`), so every field is read
 * defensively; `null` when there is nothing to show.
 */
export function describeOriginalAiValue(item: TagItem): string | null {
  const original = item.originalAiValue;
  if (!original || typeof original !== 'object') return null;
  const raw = original as Record<string, unknown>;
  const sameType = raw.equipmentTypeId === undefined || raw.equipmentTypeId === item.equipmentTypeId;
  const name = text(raw.name) ?? (sameType ? (item.equipmentType?.name ?? null) : 'a different equipment type');
  const quantity = typeof raw.quantity === 'number' ? `×${raw.quantity}` : null;
  const head = [name, quantity].filter(Boolean).join(' ');
  const detail = [text(raw.brand), text(raw.model)].filter(Boolean).join(' ');
  const parts = [head, detail, text(raw.configuration), text(raw.notes)].filter((part) => part && part.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

function AiSaidChip({ summary }: { summary: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        label="AI said…"
        onClick={(event: MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
      />
      <Popover
        id={id}
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-label': 'What the AI proposed' } as object }}
      >
        <Box sx={{ p: 1.5, maxWidth: 320 }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            <Box component="span" sx={{ fontWeight: 600 }}>
              AI said:
            </Box>{' '}
            {summary}
          </Typography>
        </Box>
      </Popover>
    </>
  );
}

export function EquipmentOriginTags({ item }: { item: TagItem }) {
  if (item.origin !== 'ai') {
    return (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" label="Added by you" />
      </Stack>
    );
  }
  const aiSaid = describeOriginalAiValue(item);
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Chip size="small" variant="outlined" label="From photo scan" />
      {item.userVerified ? (
        <Chip size="small" color="success" variant="outlined" label="You verified" />
      ) : (
        <>
          <Chip size="small" color="secondary" variant="outlined" label="AI guess" />
          <ConfidenceBadge confidence={item.confidence} />
        </>
      )}
      {aiSaid && <AiSaidChip summary={aiSaid} />}
    </Stack>
  );
}

export default EquipmentOriginTags;
