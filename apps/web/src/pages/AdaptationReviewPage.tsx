/**
 * One quick workout adaptation (`/train/adapt/:adaptationId`), E6.1.
 *
 * While it runs: the live run view (`AdaptationProgress`, the E5.6 stream
 * bound to its `runId`), refetched when the stream ends. Once ready: the
 * review (`AdaptationReview`) with Use for today only, Update my plan,
 * Discard and Adjust again. Failed, cancelled and safety-stopped states say
 * what happened and what to do next ("Try again", "Start the planned workout
 * instead").
 *
 * Routed behind `ai:use` and AI being on. Leaving never cancels the run;
 * returning replays it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, AlertTitle, Box, Button, Container, Skeleton, Stack, Typography } from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { useAdaptation } from '../hooks/useAdaptation';
import { usePermissions } from '../hooks/usePermissions';
import { useTrainingToday } from '../hooks/useTrainingToday';
import type { UseTrainingRunOptions } from '../hooks/useTrainingRun';
import { getTrainingToday, startProgramWorkout, todayRefusalOf, TODAY_REFUSALS } from '../services/programs';
import { startWorkout } from '../services/workouts';
import { ApiError } from '../services/api';
import { AdaptationProgress } from '../components/training/adapt/AdaptationProgress';
import { AdaptationReview } from '../components/training/adapt/AdaptationReview';
import { AdaptWorkoutSheet } from '../components/training/adapt/AdaptWorkoutSheet';
import { adaptationFailureCopy, exercisesAsText } from '../components/training/adapt/adaptationCopy';
import type { PlannedExercise } from '../components/training/adapt/adaptationDiff';
import { ACTIVE_ADAPTATION_STATUSES } from '../services/trainingAdaptation';
import { useAgentRunUsage } from '../hooks/useAgentUsage';
import { AgentUsagePanel } from '../components/training/usage';

export const COPY_EXERCISES_NOTICE = 'The adjusted exercises were copied. Add them from the exercise library.';

export interface AdaptationReviewPageProps {
  /** Tests inject a fake run stream. */
  runOptions?: UseTrainingRunOptions;
  /** Tests shorten the sheet's preview debounce. */
  previewDelayMs?: number;
}

export default function AdaptationReviewPage({ runOptions, previewDelayMs }: AdaptationReviewPageProps = {}) {
  const { adaptationId = '' } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const { adaptation, error, notFound, refetch, cancel, applyWorkout, applyPlan, discard } = useAdaptation(adaptationId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const wasWorking = useRef(false);
  const [justFinished, setJustFinished] = useState(false);

  const canReadPrograms = hasPermission('programs:read');
  const canApplyWorkout = hasPermission('workouts:write');
  const canApplyPlan = hasPermission('programs:write');
  const today = useTrainingToday({ enabled: canReadPrograms && !!adaptation?.baseRef });

  const status = adaptation?.status;
  const working = !!status && ACTIVE_ADAPTATION_STATUSES.includes(status);
  useEffect(() => {
    if (working) wasWorking.current = true;
    else if (wasWorking.current && status) setJustFinished(true);
  }, [status, working]);

  const planned: PlannedExercise[] | null =
    today.today?.kind === 'workout' && adaptation?.baseRef && today.today.programWorkout.id === adaptation.baseRef.planWorkoutId
      ? today.today.session.exercises.map((e) => ({
          slug: e.exercise.slug,
          name: e.exercise.name,
          sets: e.sets,
          repMin: e.repMin,
          repMax: e.repMax,
          targetRpe: e.targetRpe,
        }))
      : null;

  const onEnded = useCallback(() => void refetch(), [refetch]);

  // What the run used (E6.3), read once the run has settled: the panel below
  // the review, the cap's limit in "Not reviewed by the critic" and the cap's
  // numbers in the failure message. Nothing is read while the run is working
  // (the live view shows its own progress); the first settled render reads it.
  const usageRunId = adaptation && !working && adaptation.status !== 'blocked_safety' ? adaptation.runId : null;
  const runUsage = useAgentRunUsage(usageRunId);
  const cap = runUsage.usage?.cap ?? null;

  const adjustAgain = () => {
    setSheetMounted(true);
    setSheetOpen(true);
  };

  /** After "Update my plan": start today's (now adjusted) planned workout. */
  const startPlanned = async () => {
    const date = today.localDate();
    const fresh = await getTrainingToday(date);
    const programWorkoutId =
      fresh?.kind === 'workout' ? fresh.programWorkout.id : (adaptation?.baseRef?.planWorkoutId ?? null);
    if (!programWorkoutId) throw new Error("Couldn't find today's planned workout.");
    try {
      const result = await startProgramWorkout(programWorkoutId, { date });
      navigate(`/train/workouts/${encodeURIComponent(result.workoutId)}`);
    } catch (err) {
      if (todayRefusalOf(err) === TODAY_REFUSALS.WORKOUT_IN_PROGRESS) {
        throw new Error('Another workout is in progress. Finish it first.');
      }
      throw err instanceof ApiError ? new Error(err.message) : err;
    }
  };

  /** AI was switched off: copy the list, then open the logger with an empty workout. */
  const copyExercises = async () => {
    const proposal = adaptation?.proposal;
    if (proposal) {
      try {
        await navigator.clipboard?.writeText(exercisesAsText(proposal.title, proposal.exercises));
      } catch {
        // The logger still opens; the list stays visible on this page.
      }
    }
    const started = await startWorkout({
      ...(proposal ? { name: proposal.title.slice(0, 80) } : {}),
      ...(adaptation?.gymId ? { gymId: adaptation.gymId } : {}),
    });
    navigate(`/train/workouts/${encodeURIComponent(started.id)}`, { state: { notice: COPY_EXERCISES_NOTICE } });
  };

  const back = (
    <Button component={RouterLink} to="/train" startIcon={<BackIcon />} size="small" sx={{ mb: 1 }}>
      Train
    </Button>
  );

  let body;
  if (notFound) {
    body = <Alert severity="warning">This adjusted workout does not exist, it expired, or it is not yours.</Alert>;
  } else if (!adaptation) {
    body = error ? <Alert severity="error">{error}</Alert> : <Skeleton variant="rounded" height={160} />;
  } else if (working) {
    body = adaptation.runId ? (
      <AdaptationProgress
        runId={adaptation.runId}
        createdAt={adaptation.createdAt}
        onEnded={onEnded}
        onCancel={cancel}
        runOptions={runOptions}
      />
    ) : (
      <Typography role="status">Waiting to start…</Typography>
    );
  } else if (adaptation.status === 'failed') {
    const copy = adaptationFailureCopy(adaptation.errorCode, adaptation.errorMessage, { cap });
    body = (
      <Alert severity="error" data-testid="adapt-failed">
        <AlertTitle>{copy.title}</AlertTitle>
        {copy.body}
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap' }} useFlexGap>
          <Button variant="outlined" color="inherit" size="small" onClick={adjustAgain}>
            Try again
          </Button>
          <Button color="inherit" size="small" component={RouterLink} to="/train">
            Start the planned workout instead
          </Button>
          {copy.action && (
            <Button color="inherit" size="small" component={RouterLink} to={copy.action.to}>
              {copy.action.label}
            </Button>
          )}
        </Stack>
      </Alert>
    );
  } else if (adaptation.status === 'cancelled') {
    body = (
      <Alert
        severity="info"
        action={
          <Button color="inherit" size="small" onClick={adjustAgain}>
            Adjust again
          </Button>
        }
      >
        <AlertTitle>Cancelled</AlertTitle>
        Nothing was changed.
      </Alert>
    );
  } else {
    body = (
      <AdaptationReview
        adaptation={adaptation}
        planned={planned}
        canApplyWorkout={canApplyWorkout}
        canApplyPlan={canApplyPlan}
        onApplyWorkout={applyWorkout}
        onApplyPlan={applyPlan}
        onDiscard={discard}
        onAdjustAgain={adjustAgain}
        onStartPlanned={startPlanned}
        onCopyExercises={copyExercises}
        onRefetch={onEnded}
        focusOnMount={justFinished}
        tokenLimit={cap?.limitTokens ?? null}
      />
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {back}
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Adjusted workout
        </Typography>
        {body}
        {usageRunId && (
          <Box sx={{ mt: 3 }}>
            <AgentUsagePanel runId={usageRunId} state={runUsage} />
          </Box>
        )}
        {sheetMounted && (
          <AdaptWorkoutSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            initialRequest={adaptation?.request ?? null}
            previewDelayMs={previewDelayMs}
          />
        )}
      </Box>
    </Container>
  );
}
