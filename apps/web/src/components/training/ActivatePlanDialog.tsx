/**
 * Activate a plan with a start date, defaulting to the next day with a
 * scheduled workout. The API validates the date and the plan.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';

/** ISO weekday (1 Monday .. 7 Sunday) of a `YYYY-MM-DD` day. */
function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first day from `today` (inclusive) whose weekday has a workout, or null. */
export function nextScheduledDay(today: string, weekdays: number[]): string | null {
  const set = new Set(weekdays.filter((d) => d >= 1 && d <= 7));
  if (set.size === 0) return null;
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i);
    if (set.has(isoWeekday(day))) return day;
  }
  return null;
}

export interface ActivatePlanDialogProps {
  open: boolean;
  today: string;
  weekdays: number[];
  onClose: () => void;
  onActivate: (startDate: string) => Promise<void>;
}

export function ActivatePlanDialog({ open, today, weekdays, onClose, onActivate }: ActivatePlanDialogProps) {
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDate(nextScheduledDay(today, weekdays) ?? today);
      setError(null);
    }
  }, [open, today, weekdays]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onActivate(date);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not activate the plan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} aria-labelledby="activate-title" maxWidth="xs" fullWidth>
      <DialogTitle id="activate-title">Activate this plan</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <DialogContentText sx={{ mb: 2 }}>
          Week 1 starts on this day. Any other active plan is paused.
        </DialogContentText>
        <TextField
          label="Start date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          fullWidth
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={busy || !date}>
          Activate
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ActivatePlanDialog;
