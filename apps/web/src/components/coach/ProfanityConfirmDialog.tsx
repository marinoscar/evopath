/**
 * The 18+ confirmation for Sarge's Unhinged level (E7.3, #243;
 * docs/specs/ai-coach.md §2.4, condition 3).
 *
 * States that the content is adult language and that insults target effort
 * and excuses only. The age confirmation is a DELIBERATE action: the
 * checkbox is never pre-checked, and the confirm button stays disabled until
 * it is ticked. Confirming is the caller's `onConfirm`, which sends
 * `PUT /api/coach/settings` with `confirmAdult: true`; the server stamps the
 * time, never the browser.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
} from '@mui/material';

export interface ProfanityConfirmDialogProps {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ProfanityConfirmDialog({ open, busy = false, onConfirm, onCancel }: ProfanityConfirmDialogProps) {
  const [adult, setAdult] = useState(false);

  // Every opening starts unchecked.
  useEffect(() => {
    if (open) setAdult(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      aria-labelledby="profanity-dialog-title"
      aria-describedby="profanity-dialog-description"
    >
      <DialogTitle id="profanity-dialog-title">Turn on adult language?</DialogTitle>
      <DialogContent>
        <DialogContentText id="profanity-dialog-description" sx={{ mb: 1.5 }}>
          At Unhinged, Sarge swears: heavy, uncensored profanity in messages, previews and spoken audio. It is
          meant for adults only.
        </DialogContentText>
        <DialogContentText sx={{ mb: 1.5 }}>
          The insults are about effort and excuses only. Sarge never comments on your body, weight, health or
          identity, and safety messages are always calm and clean. Notifications on a locked screen stay clean
          while the lock-screen-safe setting is on.
        </DialogContentText>
        <DialogContentText sx={{ mb: 1 }}>
          You can turn it off at any time. Your administrator can also switch it off for everyone.
        </DialogContentText>
        <FormControlLabel
          control={<Checkbox checked={adult} onChange={(event) => setAdult(event.target.checked)} disabled={busy} />}
          label="I confirm I am 18 or older"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" color="error" onClick={onConfirm} disabled={!adult || busy}>
          {busy ? 'Turning on…' : 'Turn on adult language'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
