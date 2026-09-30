/**
 * "Save {name} for future use?" (E6.2): a temporary gym (the hotel flow's)
 * becomes a permanent one, or stays temporary.
 *
 * - **Save gym** opens a small form (name and type, a warning when another
 *   gym already has that name, no merge) and calls `onSave`, which the parent
 *   wires to `PATCH /api/gyms/:id { isTemporary: false, name, type }`. The
 *   gym keeps its id, so workouts and adaptations that reference it keep
 *   working; the API decides the default.
 * - **Not now** leaves it temporary. It stays reachable from the Temporary
 *   section on `/gyms` and the chip on `/train` until it expires.
 *
 * {@link SaveGymPrompt} is the question (the workout finish summary and the
 * applied adaptation); {@link SaveGymDialog} is the form alone in a dialog
 * (`/gyms`, `/train`, the gym page). Presentation only.
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  GYM_NAME_MAX,
  GYM_REFUSALS,
  GYM_TYPES,
  GYM_TYPE_LABEL,
  TEMPORARY_GYM_RETENTION_DAYS,
  gymRefusalMessage,
  gymRefusalReason,
  type GymType,
} from '../../services/gyms';
import { useCompactDialog } from './useCompactDialog';

export interface SaveGymTarget {
  id: string;
  name: string;
  type: GymType;
}

export interface SaveGymInput {
  name: string;
  type: GymType;
}

export const saveGymQuestion = (name: string) => `Save ${name} for future use?`;

/** Another gym with the same name (trimmed, case-insensitive), if any. */
export function nameCollision(name: string, gymId: string, others: readonly { id: string; name: string }[]): string | null {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  const match = others.find((g) => g.id !== gymId && g.name.trim().toLocaleLowerCase() === wanted);
  return match ? match.name : null;
}

export interface SaveGymFormProps {
  gym: SaveGymTarget;
  /** The caller's other gyms, for the name-collision warning. */
  otherGyms?: readonly { id: string; name: string }[];
  onSave: (input: SaveGymInput) => Promise<void>;
  onCancel: () => void;
  cancelLabel?: string;
}

/** Name and type, then Save. Rejections are shown in words and the form stays open. */
export function SaveGymForm({ gym, otherGyms = [], onSave, onCancel, cancelLabel = 'Cancel' }: SaveGymFormProps) {
  const [name, setName] = useState(gym.name);
  const [type, setType] = useState<GymType>(gym.type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const ids = useId();
  const collision = useMemo(() => nameCollision(name, gym.id, otherGyms), [name, gym.id, otherGyms]);
  const trimmed = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: trimmed, type });
    } catch (err) {
      setLimitReached(gymRefusalReason(err) === GYM_REFUSALS.GYM_LIMIT);
      setError(gymRefusalMessage(err, 'Could not save the gym'));
      setBusy(false);
    }
  };

  return (
    <Box component="form" onSubmit={(e) => void submit(e)} noValidate aria-label={`Save ${gym.name}`}>
      <Stack spacing={2}>
        <TextField
          label="Name"
          value={name}
          required
          disabled={busy}
          onChange={(e) => setName(e.target.value.slice(0, GYM_NAME_MAX))}
          error={trimmed === ''}
          helperText={trimmed === '' ? 'Give the gym a name.' : undefined}
          slotProps={{ htmlInput: { maxLength: GYM_NAME_MAX } }}
          fullWidth
        />
        <TextField
          select
          label="Type"
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as GymType)}
          fullWidth
        >
          {GYM_TYPES.map((value) => (
            <MenuItem key={value} value={value}>
              {GYM_TYPE_LABEL[value]}
            </MenuItem>
          ))}
        </TextField>
        {collision && (
          <Alert severity="info" data-testid="save-gym-collision">
            You already have a gym called {collision}. Both are kept; they are not merged.
          </Alert>
        )}
        {error && (
          <Alert severity="warning" role="alert" id={`${ids}-error`}>
            {error}{' '}
            {limitReached && (
              <Link component={RouterLink} to="/gyms">
                Open gyms
              </Link>
            )}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || trimmed === ''}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

export interface SaveGymPromptProps {
  gym: SaveGymTarget;
  otherGyms?: readonly { id: string; name: string }[];
  onSave: (input: SaveGymInput) => Promise<void>;
  /** "Not now" was chosen. */
  onDismiss?: () => void;
  headingComponent?: 'h2' | 'h3';
}

type Phase = 'ask' | 'form' | 'saved' | 'dismissed';

/** The question, then the form, then the outcome, in place. */
export function SaveGymPrompt({ gym, otherGyms, onSave, onDismiss, headingComponent = 'h3' }: SaveGymPromptProps) {
  const [phase, setPhase] = useState<Phase>('ask');
  const [savedName, setSavedName] = useState(gym.name);
  const headingId = useId();

  if (phase === 'saved') {
    return (
      <Alert severity="success" role="status" data-testid="save-gym-saved">
        Saved. {savedName} is in your gyms.{' '}
        <Link component={RouterLink} to={`/gyms/${encodeURIComponent(gym.id)}`}>
          Open gym
        </Link>
      </Alert>
    );
  }
  if (phase === 'dismissed') {
    return (
      <Typography variant="body2" color="text.secondary" role="status" data-testid="save-gym-dismissed">
        {gym.name} stays temporary. You can still save it from{' '}
        <Link component={RouterLink} to="/gyms">
          Gyms
        </Link>
        .
      </Typography>
    );
  }

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      data-testid="save-gym-prompt"
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}
    >
      <Typography id={headingId} variant="subtitle1" component={headingComponent} sx={{ overflowWrap: 'anywhere' }}>
        {saveGymQuestion(gym.name)}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        It is temporary: it is deleted {TEMPORARY_GYM_RETENTION_DAYS} days after its last change unless you save it.
      </Typography>
      {phase === 'ask' ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={() => setPhase('form')}>
            Save gym
          </Button>
          <Button
            onClick={() => {
              setPhase('dismissed');
              onDismiss?.();
            }}
          >
            Not now
          </Button>
        </Stack>
      ) : (
        <SaveGymForm
          gym={gym}
          otherGyms={otherGyms}
          onCancel={() => setPhase('ask')}
          onSave={async (input) => {
            await onSave(input);
            setSavedName(input.name);
            setPhase('saved');
          }}
        />
      )}
    </Box>
  );
}

export interface SaveGymDialogProps {
  open: boolean;
  gym: SaveGymTarget | null;
  otherGyms?: readonly { id: string; name: string }[];
  onSave: (input: SaveGymInput) => Promise<void>;
  onClose: () => void;
}

/** The form alone, in a dialog; closes after a successful save. */
export function SaveGymDialog({ open, gym, otherGyms, onSave, onClose }: SaveGymDialogProps) {
  const fullScreen = useCompactDialog();
  const titleId = useId();
  // A fresh form every time the dialog opens.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (open) setGeneration((n) => n + 1);
  }, [open]);

  return (
    <Dialog open={open && gym !== null} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="xs" aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        {gym ? saveGymQuestion(gym.name) : 'Save gym'}
      </DialogTitle>
      <DialogContent>
        {gym && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Saved gyms are kept and listed with your other gyms. Saving never replaces your default gym.
            </Typography>
            <SaveGymForm
              key={`${gym.id}:${generation}`}
              gym={gym}
              otherGyms={otherGyms}
              onCancel={onClose}
              onSave={async (input) => {
                await onSave(input);
                onClose();
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default SaveGymPrompt;
