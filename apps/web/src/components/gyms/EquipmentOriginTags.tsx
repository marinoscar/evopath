/**
 * Where a piece of equipment came from (E3.3): "Added by you" for a manual
 * row; "From photo scan" for a row a scan drafted, with "You verified" once
 * the owner confirmed or edited it, and the scan's confidence otherwise.
 * Always text, never colour alone.
 */
import { Chip, Stack } from '@mui/material';
import { ConfidenceBadge } from '../intake/ConfidenceBadge';
import type { GymEquipment } from '../../services/gyms';

export function EquipmentOriginTags({ item }: { item: Pick<GymEquipment, 'origin' | 'userVerified' | 'confidence'> }) {
  if (item.origin !== 'ai') {
    return (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" label="Added by you" />
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Chip size="small" variant="outlined" label="From photo scan" />
      {item.userVerified ? (
        <Chip size="small" color="success" variant="outlined" label="You verified" />
      ) : (
        <>
          <Chip size="small" color="warning" variant="outlined" label="Not yet verified" />
          <ConfidenceBadge confidence={item.confidence} />
        </>
      )}
    </Stack>
  );
}

export default EquipmentOriginTags;
