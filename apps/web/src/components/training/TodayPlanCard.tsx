/**
 * Today's planned session from the active training plan: shared by the Today
 * page's "Today's workout" card (`components/today/TodayWorkout.tsx`) and the
 * Train page. It only renders what `GET /api/training/today` answers; the API
 * resolves the day and builds the logged workout on start.
 *
 * States: loading, no plan, not started, rest day (with the next session and
 * "Do it anyway"), a workout (exercises, Start planned workout), done (View
 * workout), plan complete. A workout already in progress keeps the host's
 * own Resume; a start refused because another workout is in progress offers
 * Resume for that one. Errors are quiet and local, with Retry.
 */
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Chip, Link, Skeleton, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useChangeLog } from '../../hooks/useChangeLog';
import { useTrainingToday } from '../../hooks/useTrainingToday';
import { PlanAdjustedBanner } from './PlanAdjustedBanner';
import {
  duplicateProgram,
  startProgramWorkout,
  todayRefusalOf,
  TODAY_REFUSALS,
  type TodaySession,
  type TodaySessionExercise,
  type TrainingToday,
} from '../../services/programs';
import { ApiError } from '../../services/api';
import { formatLongDate } from '../../utils/localDates';
import { formatWeight, type WeightUnit } from '../../utils/units';

export const PLAN_UPDATED_NOTICE = 'Your plan was just updated; this session follows the latest version.';
export const PLAN_RESUME_NOTICE = 'You already have a workout in progress.';

export interface TodayPlanCardProps {
  /** `workouts:write`: Start and Do it anyway are offered. */
  canStart: boolean;
  /** `programs:write`: Duplicate plan is offered when the plan is complete. */
  canWritePrograms?: boolean;
}

interface StartProblem {
  message: string;
  /** Set for `WORKOUT_IN_PROGRESS`: the workout to resume. */
  resumeWorkoutId?: string;
}

function yearOf(date: string | null): number | undefined {
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : undefined;
}

function repsText(e: Pick<TodaySessionExercise, 'repMin' | 'repMax'>): string {
  return e.repMin === e.repMax ? String(e.repMin) : `${e.repMin}–${e.repMax}`;
}

/** "3 × 8–10 @ RPE 8". */
export function prescriptionText(e: TodaySessionExercise): string {
  const base = `${e.sets} × ${repsText(e)}`;
  return e.targetRpe === null ? base : `${base} @ RPE ${e.targetRpe}`;
}

/** The load to show, per `loadGuidance`, in the user's unit. */
export function loadText(e: TodaySessionExercise, unit: WeightUnit): string | null {
  if (e.exercise.isBodyweight && e.suggestedLoadKg === null) return null;
  if (e.loadGuidance === 'choose_start' || e.suggestedLoadKg === null) return 'Choose a starting load';
  return formatWeight(e.suggestedLoadKg, unit);
}

function ExerciseRow({ e, unit }: { e: TodaySessionExercise; unit: WeightUnit }) {
  const load = loadText(e, unit);
  const top = e.lastTime?.topSet ?? null;
  return (
    <Box component="li" sx={{ mb: 1 }}>
      <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{e.exercise.name}</Typography>
      <Typography variant="body2">{[prescriptionText(e), load].filter(Boolean).join(' · ')}</Typography>
      {top && (
        <Typography variant="body2" color="text.secondary">
          Last time: {formatWeight(top.weightKg, unit)} × {top.reps}
        </Typography>
      )}
      {e.availableAtGym === false && (
        <Typography variant="body2" color="warning.main">
          Not available at your gym
        </Typography>
      )}
      {e.rationale && (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {e.rationale}
        </Typography>
      )}
    </Box>
  );
}

function PlanAdjustedChip({ session }: { session: TodaySession }) {
  return (
    <Chip
      component={RouterLink}
      to={`/train/plans/${encodeURIComponent(session.programId)}/history`}
      clickable
      size="small"
      color="info"
      label="Plan adjusted"
    />
  );
}

/**
 * E5.8: when the plan has unseen AI changes, the "Plan adjusted" banner
 * (summary, Review, one-tap Undo, Dismiss). Falls back to the chip while the
 * change log loads, or when the unseen change is not one the banner shows.
 */
function PlanAdjusted({ session, canWrite, onChanged }: { session: TodaySession; canWrite: boolean; onChanged: () => void }) {
  const changeLog = useChangeLog(session.programId);
  if (!changeLog.unseenAiChange) {
    return (
      <Box sx={{ mb: 1 }}>
        <PlanAdjustedChip session={session} />
        <PlanAdjustedBanner programId={session.programId} changeLog={changeLog} canWrite={canWrite} />
      </Box>
    );
  }
  return (
    <Box sx={{ mb: 1 }}>
      <PlanAdjustedBanner programId={session.programId} changeLog={changeLog} canWrite={canWrite} onUndone={onChanged} />
    </Box>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
      {children}
    </Typography>
  );
}

function ProgramLine({ name }: { name: string }) {
  return (
    <Typography variant="overline" color="primary" component="p" sx={{ overflowWrap: 'anywhere' }}>
      {name}
    </Typography>
  );
}

export function TodayPlanCard({ canStart, canWritePrograms = false }: TodayPlanCardProps) {
  const { today, date, isLoading, error, forbidden, weightUnit, localDate, refresh } = useTrainingToday();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<StartProblem | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  const start = async (programWorkoutId: string, planVersion: number | null) => {
    setStarting(true);
    setProblem(null);
    try {
      const result = await startProgramWorkout(programWorkoutId, { date: localDate() });
      const notice = result.existing
        ? PLAN_RESUME_NOTICE
        : planVersion !== null && result.planVersion !== planVersion
          ? PLAN_UPDATED_NOTICE
          : undefined;
      navigate(`/train/workouts/${result.workoutId}`, { state: notice ? { notice } : undefined });
    } catch (err) {
      const reason = todayRefusalOf(err);
      if (reason === TODAY_REFUSALS.WORKOUT_IN_PROGRESS) {
        const workoutId = ((err as ApiError).details as { workoutId?: unknown } | undefined)?.workoutId;
        setProblem({
          message: 'Another workout is in progress. Finish it before starting this one.',
          resumeWorkoutId: typeof workoutId === 'string' ? workoutId : undefined,
        });
      } else if (reason === TODAY_REFUSALS.PROGRAM_NOT_ACTIVE) {
        setProblem({ message: 'Your plan is no longer active.' });
        void refresh();
      } else if (reason === TODAY_REFUSALS.PROGRAM_WORKOUT_EMPTY) {
        setProblem({ message: 'This planned workout has no exercises.' });
      } else {
        setProblem({ message: err instanceof ApiError ? err.message : "Couldn't start the workout" });
      }
    } finally {
      setStarting(false);
    }
  };

  const duplicate = async (programId: string) => {
    setDuplicating(true);
    setProblem(null);
    try {
      const copy = await duplicateProgram(programId);
      navigate(`/train/plans/${encodeURIComponent(copy.id)}`);
    } catch (err) {
      setProblem({ message: err instanceof ApiError ? err.message : "Couldn't duplicate the plan" });
      setDuplicating(false);
    }
  };

  // The API refused (the role lacks programs:read after all): say nothing.
  if (forbidden) return null;

  if (!today && isLoading) {
    return (
      <Box data-testid="today-plan-skeleton" sx={{ mb: 2 }}>
        <Skeleton width="50%" />
        <Skeleton width="70%" />
      </Box>
    );
  }

  if (!today) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        <Typography color="text.secondary">{error ?? "Couldn't load your plan"}</Typography>
        <Button size="small" onClick={() => void refresh()}>
          Retry
        </Button>
      </Box>
    );
  }

  const problemAlert = problem && (
    <Alert
      severity="warning"
      sx={{ mt: 1.5 }}
      action={
        problem.resumeWorkoutId ? (
          <Button component={RouterLink} to={`/train/workouts/${problem.resumeWorkoutId}`} color="inherit" size="small">
            Resume
          </Button>
        ) : undefined
      }
    >
      {problem.message}
    </Alert>
  );

  return (
    <Box data-testid="today-plan" data-kind={today.kind} sx={{ mb: 2 }}>
      <Body
        today={today}
        date={date}
        unit={weightUnit}
        canStart={canStart}
        canWritePrograms={canWritePrograms}
        starting={starting}
        duplicating={duplicating}
        onStart={(id, version) => void start(id, version)}
        onDuplicate={(id) => void duplicate(id)}
        onPlanChanged={() => void refresh()}
      />
      {problemAlert}
      {error && (
        // A background refresh failed; the state above is the last good one.
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {error}
          </Typography>
          <Button size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        </Box>
      )}
    </Box>
  );
}

interface BodyProps {
  today: TrainingToday;
  date: string | null;
  unit: WeightUnit;
  canStart: boolean;
  canWritePrograms: boolean;
  starting: boolean;
  duplicating: boolean;
  onStart: (programWorkoutId: string, planVersion: number | null) => void;
  onDuplicate: (programId: string) => void;
  /** The plan changed (an Undo): refetch Today. */
  onPlanChanged: () => void;
}

function Body({
  today,
  date,
  unit,
  canStart,
  canWritePrograms,
  starting,
  duplicating,
  onStart,
  onDuplicate,
  onPlanChanged,
}: BodyProps) {
  const year = yearOf(date);

  switch (today.kind) {
    case 'no_program':
      return (
        <Box>
          <Heading>No training plan yet</Heading>
          <Link component={RouterLink} to="/train/plans">
            Create a plan
          </Link>
        </Box>
      );

    case 'not_started':
      return (
        <Box>
          <ProgramLine name={today.program.name} />
          <Heading>{`Your plan starts ${formatLongDate(today.startsOn, year)}`}</Heading>
        </Box>
      );

    case 'program_complete':
      return (
        <Box>
          <ProgramLine name={today.program.name} />
          <Heading>Plan complete</Heading>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            You finished every week of this plan.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} useFlexGap>
            {canWritePrograms && (
              <Button
                variant="outlined"
                size="small"
                disabled={duplicating}
                onClick={() => onDuplicate(today.program.id)}
              >
                Duplicate plan
              </Button>
            )}
            <Button component={RouterLink} to="/train/plans" variant="outlined" size="small">
              Create a new plan
            </Button>
          </Stack>
        </Box>
      );

    case 'rest_day': {
      const next = today.next;
      return (
        <Box>
          <ProgramLine name={today.program.name} />
          <Heading>Rest day</Heading>
          {next ? (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Next: {next.programWorkout.name}, {formatLongDate(next.date, year)}
              </Typography>
              {canStart && (
                <Button
                  variant="outlined"
                  size="small"
                  disabled={starting}
                  onClick={() => onStart(next.programWorkout.id, null)}
                >
                  Do it anyway
                </Button>
              )}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No sessions in the next two weeks.
            </Typography>
          )}
        </Box>
      );
    }

    case 'workout': {
      const { session } = today;
      const meta = [
        `Week ${today.weekNumber} of ${today.totalWeeks}`,
        session.estimatedMinutes ? `about ${session.estimatedMinutes} min` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      if (today.done) {
        return (
          <Box>
            <ProgramLine name={today.program.name} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CheckCircleIcon color="success" aria-hidden />
              <Heading>{`${session.name}: done`}</Heading>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {meta}
            </Typography>
            {today.completedWorkoutId && (
              <Button
                component={RouterLink}
                to={`/train/workouts/${today.completedWorkoutId}`}
                variant="outlined"
                size="small"
              >
                View workout
              </Button>
            )}
          </Box>
        );
      }

      const empty = session.exercises.length === 0;
      return (
        <Box>
          <ProgramLine name={today.program.name} />
          <Heading>{session.name}</Heading>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {meta}
            </Typography>
            {today.isDeload && <Chip size="small" label="Deload" />}
            {today.inProgressWorkoutId && <Chip size="small" color="primary" label="In progress" />}
          </Box>
          {session.unseenChangeCount > 0 && (
            <PlanAdjusted session={session} canWrite={canWritePrograms} onChanged={onPlanChanged} />
          )}
          {empty ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              No exercises
            </Typography>
          ) : (
            <Box component="ul" aria-label="Planned exercises" sx={{ m: 0, mb: 1, pl: 2.5 }}>
              {session.exercises.map((e) => (
                <ExerciseRow key={e.programExerciseId} e={e} unit={unit} />
              ))}
            </Box>
          )}
          {canStart && !today.inProgressWorkoutId && (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon aria-hidden />}
              disabled={empty || starting}
              onClick={() => onStart(today.programWorkout.id, session.planVersion)}
            >
              Start planned workout
            </Button>
          )}
        </Box>
      );
    }
  }
}

export default TodayPlanCard;
