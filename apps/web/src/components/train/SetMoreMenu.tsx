/**
 * A set row's secondary controls (E4.3), in a popover: warm-up, exact RPE and
 * RIR (the row's effort chips follow them), rest, the discomfort note, set
 * notes, and delete. Every change is sent through the row, so a failed save
 * shows there with Retry.
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Divider,
  FormControlLabel,
  MenuItem,
  Popover,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { DeleteOutlined as DeleteIcon } from '@mui/icons-material';
import {
  SET_BOUNDS,
  SET_NOTES_MAX,
  SET_PAIN_NOTE_MAX,
  type SetInput,
  type SetLogView,
} from '../../services/workouts';
import type { TrackingMode } from '../../services/exercises';
import { RIR_OPTIONS, RPE_OPTIONS, parseWholeNumber } from '../../utils/workoutFormat';

export interface SetMoreMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  set: SetLogView;
  trackingMode: TrackingMode;
  canWrite: boolean;
  /** Bodyweight rows: whether the "+ weight" field is shown. */
  showAddedWeight: boolean;
  onToggleAddedWeight: (show: boolean) => void;
  onPatch: (patch: SetInput) => void;
  onDelete: () => void;
}

const nullableText = (text: string): string | null => (text.trim() === '' ? null : text.trim());

export function SetMoreMenu({
  anchorEl,
  open,
  onClose,
  set,
  trackingMode,
  canWrite,
  showAddedWeight,
  onToggleAddedWeight,
  onPatch,
  onDelete,
}: SetMoreMenuProps) {
  const n = set.setNumber;
  const [rest, setRest] = useState('');
  const [restError, setRestError] = useState<string | null>(null);
  const [painNote, setPainNote] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (open) {
      setRest(set.restSeconds === null ? '' : String(set.restSeconds));
      setRestError(null);
      setPainNote(set.painNote ?? '');
      setNotes(set.notes ?? '');
    }
    // Only when the popover opens: typing must not be overwritten by a save.
  }, [open]);

  const saveRest = () => {
    const parsed = parseWholeNumber(rest, SET_BOUNDS.restSeconds.min, SET_BOUNDS.restSeconds.max);
    if (!parsed.ok) {
      setRestError(parsed.message);
      return;
    }
    setRestError(null);
    if (parsed.value !== set.restSeconds) onPatch({ restSeconds: parsed.value });
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: { role: 'dialog', 'aria-label': `More for set ${n}`, sx: { width: 300, maxWidth: 'calc(100vw - 32px)' } },
      }}
    >
      <Stack spacing={1.5} sx={{ p: 2 }}>
        <Typography variant="subtitle2" component="h3">
          Set {n}
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={set.isWarmup}
              disabled={!canWrite}
              onChange={(e) => onPatch({ isWarmup: e.target.checked })}
            />
          }
          label="Warm-up"
        />
        {trackingMode === 'bodyweight_reps' && (
          <FormControlLabel
            control={
              <Switch
                checked={showAddedWeight}
                disabled={!canWrite}
                onChange={(e) => onToggleAddedWeight(e.target.checked)}
              />
            }
            label="Added weight"
          />
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            select
            size="small"
            label="RPE"
            value={set.rpe === null ? '' : String(set.rpe)}
            disabled={!canWrite}
            onChange={(e) => onPatch({ rpe: e.target.value === '' ? null : Number(e.target.value) })}
            sx={{ flex: 1 }}
          >
            <MenuItem value="">None</MenuItem>
            {RPE_OPTIONS.map((v) => (
              <MenuItem key={v} value={String(v)}>
                {v}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="RIR"
            value={set.rir === null ? '' : String(set.rir)}
            disabled={!canWrite}
            onChange={(e) => onPatch({ rir: e.target.value === '' ? null : Number(e.target.value) })}
            sx={{ flex: 1 }}
          >
            <MenuItem value="">None</MenuItem>
            {RIR_OPTIONS.map((v) => (
              <MenuItem key={v} value={String(v)}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <TextField
          size="small"
          label="Rest before this set (seconds)"
          value={rest}
          disabled={!canWrite}
          onChange={(e) => setRest(e.target.value)}
          onBlur={saveRest}
          error={restError !== null}
          helperText={restError ?? 'Recorded automatically between sets; edit if needed.'}
          slotProps={{ htmlInput: { inputMode: 'numeric' } }}
        />
        {set.painFlag && (
          <TextField
            size="small"
            label="Discomfort note (optional)"
            value={painNote}
            disabled={!canWrite}
            onChange={(e) => setPainNote(e.target.value)}
            onBlur={() => {
              const value = nullableText(painNote);
              if (value !== set.painNote) onPatch({ painNote: value });
            }}
            multiline
            slotProps={{ htmlInput: { maxLength: SET_PAIN_NOTE_MAX } }}
          />
        )}
        <TextField
          size="small"
          label="Set notes"
          value={notes}
          disabled={!canWrite}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            const value = nullableText(notes);
            if (value !== set.notes) onPatch({ notes: value });
          }}
          multiline
          slotProps={{ htmlInput: { maxLength: SET_NOTES_MAX } }}
        />
        {canWrite && (
          <>
            <Divider />
            <Button color="error" startIcon={<DeleteIcon />} onClick={onDelete} sx={{ alignSelf: 'flex-start' }}>
              Delete set {n}
            </Button>
          </>
        )}
      </Stack>
    </Popover>
  );
}
