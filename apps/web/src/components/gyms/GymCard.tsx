/**
 * One gym on `/gyms` (E3.3): cover photo, name, type, Default and Temporary
 * chips, equipment and photo counts, and Open / Set default / Delete.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Card, CardActions, CardContent, Chip, Stack, Typography } from '@mui/material';
import { Place as PlaceIcon } from '@mui/icons-material';
import { StoragePhotoThumb } from '../intake/StoragePhotoThumb';
import { GYM_TYPE_LABEL, gymErrorMessage, type GymSummary } from '../../services/gyms';

export interface GymCardProps {
  gym: GymSummary;
  canWrite: boolean;
  onSetDefault: (gym: GymSummary) => Promise<void>;
  onDelete: (gym: GymSummary) => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function GymCard({ gym, canWrite, onSetDefault, onDelete }: GymCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = `gym-card-${gym.id}`;
  const cover = gym.coverStorageObjectId ?? null;

  const makeDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSetDefault(gym);
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not set the default gym'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardContent sx={{ flexGrow: 1, display: 'flex', gap: 2, minWidth: 0 }}>
        {cover ? (
          <StoragePhotoThumb storageObjectId={cover} name={`${gym.name} cover photo`} size={72} />
        ) : (
          <Box
            aria-hidden
            sx={{
              width: 72,
              height: 72,
              borderRadius: 1,
              bgcolor: 'action.hover',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <PlaceIcon color="disabled" />
          </Box>
        )}
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography id={headingId} variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
            {gym.name}
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', my: 0.5 }}>
            <Chip size="small" variant="outlined" label={GYM_TYPE_LABEL[gym.type] ?? gym.type} />
            {gym.isDefault && <Chip size="small" color="primary" label="Default" />}
            {gym.isTemporary && <Chip size="small" color="secondary" variant="outlined" label="Temporary" />}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {plural(gym.equipmentCount, 'piece of equipment', 'pieces of equipment')} ·{' '}
            {plural(gym.photoCount, 'photo', 'photos')}
          </Typography>
          {error && (
            <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>
              {error}
            </Typography>
          )}
        </Box>
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button component={RouterLink} to={`/gyms/${gym.id}`} aria-label={`Open ${gym.name}`}>
          Open
        </Button>
        {canWrite && !gym.isDefault && (
          <Button onClick={() => void makeDefault()} disabled={busy} aria-label={`Set ${gym.name} as default`}>
            Set default
          </Button>
        )}
        {canWrite && (
          <Button color="error" onClick={() => onDelete(gym)} disabled={busy} aria-label={`Delete ${gym.name}`}>
            Delete
          </Button>
        )}
      </CardActions>
    </Card>
  );
}

export default GymCard;
