/**
 * The workout's header (E4.3). In progress: the name (inline edit), the gym
 * chip (tap to change; the exercises stay, only the picker's filter moves),
 * a live elapsed timer that is never announced, and Finish. Completed: a
 * "Completed" chip, the date and duration, Edit details and Delete workout.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Check as CheckIcon,
  Close as CloseIcon,
  DeleteOutlined as DeleteIcon,
  Edit as EditIcon,
  Place as PlaceIcon,
} from '@mui/icons-material';
import { WORKOUT_NAME_MAX, type Workout } from '../../services/workouts';
import type { GymSummary } from '../../services/gyms';
import { formatLongDate } from '../../utils/localDates';
import { formatClock, formatDuration } from '../../utils/workoutFormat';

export const NO_GYM_CHIP = 'No gym';

function elapsedSeconds(startedAt: string, now: number): number {
  const start = new Date(startedAt).getTime();
  return Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

/** The live timer; `aria-live="off"` so screen readers are not told every second. */
export function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Typography
      component="span"
      aria-live="off"
      aria-label="Elapsed time"
      role="timer"
      sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}
    >
      {formatClock(elapsedSeconds(startedAt, now))}
    </Typography>
  );
}

export interface WorkoutHeaderProps {
  workout: Workout;
  canWrite: boolean;
  gyms: GymSummary[];
  onRename: (name: string) => Promise<unknown>;
  onChangeGym: (gymId: string | null) => Promise<unknown>;
  onFinish?: () => void;
  finishing?: boolean;
  onEditDetails?: () => void;
  onDelete?: () => void;
}

export function WorkoutHeader({
  workout,
  canWrite,
  gyms,
  onRename,
  onChangeGym,
  onFinish,
  finishing = false,
  onEditDetails,
  onDelete,
}: WorkoutHeaderProps) {
  const completed = workout.status === 'completed';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workout.name);
  const [gymAnchor, setGymAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!editing) setName(workout.name);
  }, [workout.name, editing]);

  const submitName = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (trimmed && trimmed !== workout.name) {
      try {
        await onRename(trimmed);
      } catch {
        return;
      }
    }
    setEditing(false);
  };

  const gymLabel = workout.gym?.name ?? NO_GYM_CHIP;

  return (
    <Box component="header" sx={{ mb: 2 }}>
      {editing ? (
        <Box
          component="form"
          onSubmit={(e: FormEvent) => void submitName(e)}
          sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
        >
          <TextField
            label="Workout name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setName(workout.name);
                setEditing(false);
              }
            }}
            autoFocus
            size="small"
            fullWidth
            slotProps={{ htmlInput: { maxLength: WORKOUT_NAME_MAX } }}
          />
          <IconButton type="submit" aria-label="Save name">
            <CheckIcon />
          </IconButton>
          <IconButton
            aria-label="Cancel renaming"
            onClick={() => {
              setName(workout.name);
              setEditing(false);
            }}
          >
            <CloseIcon />
          </IconButton>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h4" component="h1" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            {workout.name}
          </Typography>
          {canWrite && !completed && (
            <IconButton aria-label="Rename workout" onClick={() => setEditing(true)}>
              <EditIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center', rowGap: 1 }}>
        {completed && <Chip label="Completed" color="success" size="small" />}
        {canWrite && !completed ? (
          <Chip
            icon={<PlaceIcon />}
            label={gymLabel}
            variant="outlined"
            onClick={(e) => setGymAnchor(e.currentTarget)}
            aria-label={`Gym: ${gymLabel}. Change gym`}
            aria-haspopup="menu"
          />
        ) : (
          <Chip icon={<PlaceIcon />} label={gymLabel} variant="outlined" />
        )}
        {completed ? (
          <Typography variant="body2" color="text.secondary">
            {formatLongDate(workout.date)}
            {workout.durationSeconds !== null ? ` · ${formatDuration(workout.durationSeconds)}` : ''}
          </Typography>
        ) : (
          <ElapsedTimer startedAt={workout.startedAt} />
        )}
        <Box sx={{ flexGrow: 1 }} />
        {!completed && canWrite && onFinish && (
          <Button variant="contained" onClick={onFinish} disabled={finishing} sx={{ minHeight: 44 }}>
            {finishing ? 'Finishing…' : 'Finish'}
          </Button>
        )}
        {completed && canWrite && (
          <>
            <Button startIcon={<EditIcon />} onClick={onEditDetails} sx={{ minHeight: 44 }}>
              Edit details
            </Button>
            <Button color="error" startIcon={<DeleteIcon />} onClick={onDelete} sx={{ minHeight: 44 }}>
              Delete workout
            </Button>
          </>
        )}
      </Stack>

      <Menu anchorEl={gymAnchor} open={gymAnchor !== null} onClose={() => setGymAnchor(null)}>
        {gyms.map((gym) => (
          <MenuItem
            key={gym.id}
            selected={gym.id === workout.gymId}
            onClick={() => {
              setGymAnchor(null);
              if (gym.id !== workout.gymId) void onChangeGym(gym.id).catch(() => undefined);
            }}
          >
            {gym.name}
          </MenuItem>
        ))}
        <MenuItem
          selected={workout.gymId === null}
          onClick={() => {
            setGymAnchor(null);
            if (workout.gymId !== null) void onChangeGym(null).catch(() => undefined);
          }}
        >
          No gym / bodyweight
        </MenuItem>
      </Menu>
    </Box>
  );
}
