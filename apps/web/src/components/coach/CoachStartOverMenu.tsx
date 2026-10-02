/**
 * The `/coach` conversation menu (#323; docs/specs/ai-coach.md §2.9): an
 * overflow button whose one item, "Start over", opens a confirmation dialog.
 *
 * Confirming calls `onConfirm` (the page posts `POST /api/coach/chat/clear`
 * and resets the timeline). The dialog stays open with an inline error when
 * that fails, and closes on success. The whole control is disabled while a
 * chat turn streams, so a clear never races a reply being written.
 */
import { useId, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

export const COACH_START_OVER_LABEL = 'Start over';
export const COACH_CONVERSATION_MENU_LABEL = 'Conversation options';
export const COACH_START_OVER_TITLE = 'Start a fresh conversation?';
export const COACH_START_OVER_TEXT =
  "Your coach won't see earlier messages. Your memories and settings stay.";

export interface CoachStartOverMenuProps {
  /** True while a chat turn streams (or the timeline is loading). */
  disabled?: boolean;
  /** Clears the chat; rejects with a user-facing message on failure. */
  onConfirm: () => Promise<void>;
}

export function CoachStartOverMenu({ disabled = false, onConfirm }: CoachStartOverMenuProps) {
  const menuId = useId();
  const titleId = useId();
  const textId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not start over. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip title={COACH_CONVERSATION_MENU_LABEL}>
        <span>
          <IconButton
            aria-label={COACH_CONVERSATION_MENU_LABEL}
            aria-haspopup="menu"
            aria-controls={anchor ? menuId : undefined}
            aria-expanded={anchor ? 'true' : undefined}
            disabled={disabled}
            onClick={(event) => setAnchor(event.currentTarget)}
            sx={{ minWidth: 44, minHeight: 44 }}
          >
            <MoreVertIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          disabled={disabled}
          onClick={() => {
            setAnchor(null);
            setOpen(true);
          }}
          sx={{ minHeight: 44 }}
        >
          <ListItemIcon>
            <RestartAltIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{COACH_START_OVER_LABEL}</ListItemText>
        </MenuItem>
      </Menu>
      <Dialog open={open} onClose={close} aria-labelledby={titleId} aria-describedby={textId}>
        <DialogTitle id={titleId}>{COACH_START_OVER_TITLE}</DialogTitle>
        <DialogContent>
          <DialogContentText id={textId}>{COACH_START_OVER_TEXT}</DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={close} disabled={busy} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            onClick={() => void confirm()}
            variant="contained"
            disabled={busy || disabled}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ minHeight: 44 }}
          >
            {COACH_START_OVER_LABEL}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
