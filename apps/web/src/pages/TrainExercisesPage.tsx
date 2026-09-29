/**
 * Exercise library (`/train/exercises`), E4.1. Browse the seeded library and
 * the caller's own custom exercises: search by name or alias, narrow by muscle,
 * show only custom ones, and open an exercise to see what it trains and what
 * equipment it needs. "New custom exercise" opens {@link CustomExerciseDialog}.
 *
 * Owned by the `train` destination through the `/train` prefix. `exercises:read`
 * decides whether there is anything to show and `exercises:write` whether the
 * create action is offered; the API enforces both on every call. Everything
 * here works with AI off.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowBack as ArrowBackIcon,
  Close as CloseIcon,
  FitnessCenter as FitnessCenterIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useExerciseDetail, useExercises } from '../hooks/useExercises';
import {
  EXERCISES_UNAVAILABLE,
  EXERCISE_QUERY_MAX,
  MUSCLES,
  muscleLabel,
  patternLabel,
  trackingLabel,
  type Exercise,
  type ExerciseDetail,
} from '../services/exercises';
import { EmptyState } from '../components/common/EmptyState';
import { CustomExerciseDialog } from '../components/train/CustomExerciseDialog';

export const EXERCISES_TITLE = 'Exercise library';
export const EXERCISES_SUBTITLE =
  'Every exercise you can log, what it trains and the equipment it needs. Add your own when one is missing.';

function musclesLine(exercise: Pick<Exercise, 'primaryMuscles'>): string {
  return exercise.primaryMuscles.map(muscleLabel).join(', ');
}

function ExerciseChips({ exercise }: { exercise: Exercise }) {
  return (
    <>
      {exercise.isCustom && <Chip label="Custom" size="small" color="primary" variant="outlined" />}
      {exercise.status === 'pending_review' && (
        <Chip label="Needs your OK" size="small" color="warning" variant="outlined" />
      )}
    </>
  );
}

function RequirementsSection({ exercise }: { exercise: ExerciseDetail }) {
  const groups = [...(exercise.requirements ?? [])].sort((a, b) => a.groupIndex - b.groupIndex);
  return (
    <Box component="section" aria-labelledby="exercise-requirements-heading">
      <Typography
        id="exercise-requirements-heading"
        variant="subtitle2"
        component="h3"
        gutterBottom
      >
        Equipment needed
      </Typography>
      {groups.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Needs no equipment.
        </Typography>
      ) : (
        <List dense disablePadding aria-label="Requirements">
          {groups.map((group, i) => (
            <Box component="li" key={group.groupIndex} sx={{ listStyle: 'none', py: 0.5 }}>
              <Typography variant="body2">
                {i > 0 && (
                  <Typography component="span" variant="body2" color="text.secondary">
                    and{' '}
                  </Typography>
                )}
                {group.options.length > 1 ? 'One of: ' : ''}
                {group.options.map((o) => o.name).join(', ')}
              </Typography>
            </Box>
          ))}
        </List>
      )}
    </Box>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Box>
  );
}

function ExerciseDrawer({
  exerciseId,
  onClose,
}: {
  exerciseId: string | null;
  onClose: () => void;
}) {
  const { exercise, isLoading, error } = useExerciseDetail(exerciseId);
  const open = exerciseId !== null;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: { width: { xs: '100%', sm: 420 }, maxWidth: '100%' },
          role: 'dialog',
          'aria-labelledby': 'exercise-detail-title',
        },
      }}
    >
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
          <Typography
            id="exercise-detail-title"
            variant="h6"
            component="h2"
            sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {exercise?.name ?? 'Exercise'}
          </Typography>
          <IconButton aria-label="Close" onClick={onClose} edge="end">
            <CloseIcon />
          </IconButton>
        </Box>
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress aria-label="Loading exercise" />
          </Box>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {exercise && (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Chip
                label={exercise.isCustom ? 'Custom' : 'Library'}
                size="small"
                variant="outlined"
              />
              {exercise.status === 'pending_review' && (
                <Chip label="Needs your OK" size="small" color="warning" variant="outlined" />
              )}
              {exercise.isBodyweight && <Chip label="Bodyweight" size="small" variant="outlined" />}
              {exercise.isUnilateral && (
                <Chip label="One side at a time" size="small" variant="outlined" />
              )}
            </Stack>
            <DetailRow label="Primary muscles" value={musclesLine(exercise)} />
            {exercise.secondaryMuscles.length > 0 && (
              <DetailRow
                label="Secondary muscles"
                value={exercise.secondaryMuscles.map(muscleLabel).join(', ')}
              />
            )}
            <DetailRow label="Movement pattern" value={patternLabel(exercise.movementPattern)} />
            <DetailRow label="Tracking" value={trackingLabel(exercise.trackingMode)} />
            {exercise.aliases.length > 0 && (
              <DetailRow label="Also called" value={exercise.aliases.join(', ')} />
            )}
            <Divider />
            <RequirementsSection exercise={exercise} />
            {exercise.notes && (
              <>
                <Divider />
                <DetailRow label="Notes" value={exercise.notes} />
              </>
            )}
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}

function ExerciseLibrary({ canWrite }: { canWrite: boolean }) {
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<string | null>(null);
  const [customOnly, setCustomOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { exercises, isLoading, error, forbidden, refresh, create } = useExercises({
    q,
    muscle,
    // Omitted (not `false`) lists the library and custom exercises together.
    custom: customOnly ? true : undefined,
  });

  if (forbidden) return <Alert severity="info">{EXERCISES_UNAVAILABLE}</Alert>;

  const filtered = q.trim() !== '' || muscle !== null || customOnly;

  let results;
  if (error && exercises.length === 0 && !isLoading) {
    results = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={refresh}>
            Retry
          </Button>
        }
      >
        Could not load exercises. {error}
      </Alert>
    );
  } else if (isLoading && exercises.length === 0) {
    results = (
      <Stack spacing={1} data-testid="exercises-skeleton">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={56} />
        ))}
      </Stack>
    );
  } else if (exercises.length === 0) {
    results = (
      <EmptyState
        Icon={FitnessCenterIcon}
        title={
          customOnly && q.trim() === '' && muscle === null
            ? 'No custom exercises yet'
            : 'No exercises found'
        }
        description={
          filtered
            ? 'Try another search or clear the filters. If the library lacks an exercise, add your own.'
            : 'The library is empty.'
        }
        action={
          canWrite ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              New custom exercise
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    results = (
      <Paper variant="outlined">
        <List aria-label="Exercises" disablePadding>
          {exercises.map((exercise, i) => (
            <ListItem key={exercise.id} disablePadding divider={i < exercises.length - 1}>
              <ListItemButton onClick={() => setSelectedId(exercise.id)}>
                <ListItemText
                  primary={
                    <Box
                      component="span"
                      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}
                    >
                      <span>{exercise.name}</span>
                      <ExerciseChips exercise={exercise} />
                    </Box>
                  }
                  secondary={`${musclesLine(exercise)} · ${patternLabel(exercise.movementPattern)}`}
                  slotProps={{ secondary: { sx: { overflowWrap: 'anywhere' } } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Paper>
    );
  }

  return (
    <>
      {canWrite && (
        <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', sm: 'flex-end' }, mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            New custom exercise
          </Button>
        </Box>
      )}
      <Stack spacing={2} sx={{ mb: 2 }}>
        <TextField
          type="search"
          label="Search exercises"
          placeholder="Name or alias"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          fullWidth
          slotProps={{
            htmlInput: { maxLength: EXERCISE_QUERY_MAX },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            },
          }}
        />
        <Box
          role="group"
          aria-label="Filter by muscle"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
        >
          <Chip
            label="All muscles"
            clickable
            color={muscle === null ? 'primary' : 'default'}
            variant={muscle === null ? 'filled' : 'outlined'}
            aria-pressed={muscle === null}
            onClick={() => setMuscle(null)}
          />
          {MUSCLES.map((m) => (
            <Chip
              key={m}
              label={muscleLabel(m)}
              clickable
              color={muscle === m ? 'primary' : 'default'}
              variant={muscle === m ? 'filled' : 'outlined'}
              aria-pressed={muscle === m}
              onClick={() => setMuscle(muscle === m ? null : m)}
            />
          ))}
        </Box>
        <FormControlLabel
          control={
            <Switch checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} />
          }
          label="Custom only"
        />
      </Stack>
      {results}
      <ExerciseDrawer exerciseId={selectedId} onClose={() => setSelectedId(null)} />
      {canWrite && (
        <CustomExerciseDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={create}
        />
      )}
    </>
  );
}

export default function TrainExercisesPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('exercises:read');
  const canWrite = hasPermission('exercises:write');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Link
          component={RouterLink}
          to="/train"
          underline="hover"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1 }}
        >
          <ArrowBackIcon fontSize="small" aria-hidden />
          Train
        </Link>
        <Typography variant="h4" component="h1" gutterBottom sx={{ overflowWrap: 'anywhere' }}>
          {EXERCISES_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {EXERCISES_SUBTITLE}
        </Typography>
        {canRead ? (
          <ExerciseLibrary canWrite={canWrite} />
        ) : (
          <Alert severity="info">{EXERCISES_UNAVAILABLE}</Alert>
        )}
      </Box>
    </Container>
  );
}
