/**
 * The goal check-in sheet (#268, #267): record one activity entry in three
 * ways, then let the caller refresh progress.
 *
 * - "I did it": `{ activityKind }` (one session).
 * - "Minutes": `{ activityKind, durationSeconds }`.
 * - "Steps": `{ activityKind: 'steps', steps }` (a daily total).
 *
 * The mode starts from the goal (a steps goal opens on Steps, a minutes goal on
 * Minutes). "Which day" offers today back to seven days; today is left to the
 * server's own local day. A bottom sheet below `sm` (a dialog-presentation
 * choice, not one of the five navigation breakpoint gates), a dialog above.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { CheckCircle as DoneIcon } from '@mui/icons-material';
import { useCompactDialog } from '../gyms/useCompactDialog';
import {
  ENTRY_DURATION_MAX_SECONDS,
  ENTRY_MAX_DAYS_BACK,
  ENTRY_STEPS_MAX,
  createActivityEntry,
  goalErrorMessage,
  type ActivityEntry,
  type Goal,
} from '../../services/goals';
import { localDateIn, formatDayLabel } from '../../utils/localDates';
import {
  activityLabel,
  addDays,
  checkInEntry,
  defaultCheckInMode,
  type CheckInMode,
} from '../../utils/goalFormat';

export interface CheckInSheetProps {
  open: boolean;
  goal: Goal | null;
  onClose: () => void;
  /** After the entry is stored. */
  onSaved: (entry: ActivityEntry) => void;
}

const MODE_LABELS: Record<CheckInMode, string> = {
  done: 'I did it',
  minutes: 'Minutes',
  steps: 'Steps',
};

export function CheckInSheet({ open, goal, onClose, onSaved }: CheckInSheetProps) {
  const compact = useCompactDialog();
  const titleId = useId();
  const [mode, setMode] = useState<CheckInMode>('done');
  const [amount, setAmount] = useState('');
  const [daysBack, setDaysBack] = useState(0);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !goal) return;
    setMode(defaultCheckInMode(goal));
    setAmount('');
    setDaysBack(0);
    setAmountError(null);
    setError(null);
  }, [open, goal]);

  if (!goal) return null;

  // An "any workout" goal counts logged workouts; only its steps can be checked in.
  const modes: CheckInMode[] = goal.activityKind === 'workout_any' ? ['steps'] : ['done', 'minutes', 'steps'];
  const today = localDateIn(null);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    let value = 0;
    if (mode !== 'done') {
      value = Number(amount);
      const max = mode === 'steps' ? ENTRY_STEPS_MAX : ENTRY_DURATION_MAX_SECONDS / 60;
      if (!amount.trim() || !Number.isInteger(value) || value <= 0) {
        setAmountError('Enter a whole number above zero.');
        return;
      }
      if (value > max) {
        setAmountError(`That is more than ${max.toLocaleString('en-US')}.`);
        return;
      }
    }
    setAmountError(null);
    setSaving(true);
    setError(null);
    try {
      const entry = await createActivityEntry(
        checkInEntry(goal, mode, value, daysBack === 0 ? undefined : addDays(today, -daysBack)),
      );
      onSaved(entry);
    } catch (err) {
      setError(goalErrorMessage(err, 'Could not save your check-in.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
      slotProps={{
        paper: {
          sx: compact
            ? { m: 0, width: '100%', maxWidth: '100%', position: 'fixed', bottom: 0, borderRadius: '16px 16px 0 0' }
            : undefined,
        },
      }}
    >
      <Box component="form" noValidate onSubmit={save} sx={{ display: 'contents' }}>
        <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
          Check in: {goal.title}
        </DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {modes.length > 1 && (
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={mode}
              onChange={(_, value: CheckInMode | null) => {
                if (value) {
                  setMode(value);
                  setAmountError(null);
                }
              }}
              aria-label="How to check in"
              sx={{ mb: 2 }}
            >
              {modes.map((m) => (
                <ToggleButton key={m} value={m} sx={{ minHeight: 44 }}>
                  {MODE_LABELS[m]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          <Box sx={{ display: 'grid', gap: 2 }}>
            {mode === 'done' ? (
              <Button
                type="submit"
                variant="contained"
                size="large"
                startIcon={<DoneIcon />}
                disabled={saving}
                sx={{ minHeight: 64, fontSize: '1.125rem' }}
              >
                I did it
              </Button>
            ) : (
              <TextField
                label={mode === 'steps' ? 'Steps' : 'Minutes'}
                type="number"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountError(null);
                }}
                error={Boolean(amountError)}
                helperText={amountError ?? (mode === 'steps' ? 'Your step count for that day.' : undefined)}
                autoFocus
                fullWidth
                slotProps={{
                  htmlInput: { min: 1, step: 1, inputMode: 'numeric' },
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">{mode === 'steps' ? 'steps' : 'min'}</InputAdornment>
                    ),
                  },
                }}
              />
            )}
            <TextField
              select
              label="Which day"
              value={daysBack}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              fullWidth
              size="small"
            >
              {Array.from({ length: ENTRY_MAX_DAYS_BACK + 1 }, (_, n) => (
                <MenuItem key={n} value={n}>
                  {formatDayLabel(addDays(today, -n), today)}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2" color="text.secondary">
              {mode === 'steps' ? 'Counts toward your step goals.' : `Counts as ${activityLabel(goal).toLowerCase()}.`}
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {mode !== 'done' && (
            <Button type="submit" variant="contained" disabled={saving}>
              Save
            </Button>
          )}
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export default CheckInSheet;
