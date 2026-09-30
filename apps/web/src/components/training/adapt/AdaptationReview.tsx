/**
 * The adjusted workout, for review (E6.1): an AI badge and "Draft, not
 * medical advice"; the diff against the planned workout (kept, swapped with
 * an arrow, dropped with its reason, added; icons and words, never colour
 * alone); estimated minutes against what was asked; the rationale and what
 * was assumed; the guardrails' notes; the critic's verdict or "Not reviewed
 * by the critic". The proposal is read-only here: sets and exercises are
 * edited in the logger after applying.
 *
 * Actions: Use for today only, Update my plan (disabled with the reason when
 * there was no planned workout), Discard, Adjust again. A refused action is
 * explained with the step that resolves it (`409 WORKOUT_IN_PROGRESS`,
 * `ADAPTATION_STALE`, `ADAPTATION_IN_PROGRESS`, `403 AI_DISABLED` with the
 * "Copy exercises" fallback). A safety stop renders the guidance only.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddedIcon,
  ArrowForward as ArrowIcon,
  AutoAwesome as AiIcon,
  Check as KeptIcon,
  RemoveCircleOutlined as DroppedIcon,
  SwapHoriz as SwappedIcon,
} from '@mui/icons-material';
import type {
  AdaptationView,
  ApplyPlanResult,
  ApplyWorkoutResult,
} from '../../../services/trainingAdaptation';
import { ApplyDialog, type ApplyMode } from './ApplyDialog';
import { applyProblemOf, type ApplyProblem } from './adaptationCopy';
import { buildAdaptationDiff, type DiffRow, type PlannedExercise } from './adaptationDiff';
import { DROP_REASON_LABEL } from './adaptDraft';

export const DRAFT_NOTICE = 'Draft, not medical advice.';
export const NOT_REVIEWED = 'Not reviewed by the critic';
export const PLAN_CHANGED_NOTICE = 'Your plan changed since this was adjusted; the adjusted workout was still created.';

const WARNING_TEXT: Record<string, string> = {
  revision_rejected: "The critic's revision broke a rule, so the first version was kept.",
  critic_skipped: 'The critic did not review this workout.',
  revision_skipped_token_cap:
    'The critic asked for changes, but your token limit was reached, so the first checked version was kept.',
};

const tokenCount = new Intl.NumberFormat('en-US');

/**
 * The critic was skipped (or cut short) by the per-run token cap (E6.3). The
 * proposal already passed the guardrails, so it stays usable.
 */
export function notReviewedTokenCapText(limitTokens: number | null | undefined): string {
  const limit = typeof limitTokens === 'number' ? ` (${tokenCount.format(limitTokens)})` : '';
  return `${NOT_REVIEWED}: your token limit${limit} was reached`;
}

export interface AdaptationReviewProps {
  adaptation: AdaptationView;
  /** Today's planned exercises (for the "before" side and swapped names); null when unknown. */
  planned: PlannedExercise[] | null;
  /** `workouts:write`. */
  canApplyWorkout: boolean;
  /** `programs:write`. */
  canApplyPlan: boolean;
  onApplyWorkout: () => Promise<ApplyWorkoutResult>;
  onApplyPlan: () => Promise<ApplyPlanResult>;
  onDiscard: () => Promise<void>;
  onAdjustAgain: () => void;
  /** After "Update my plan": start today's (now adjusted) planned workout. */
  onStartPlanned: () => Promise<void>;
  /** AI was switched off: open the logger with an empty workout (the list is copied). */
  onCopyExercises: () => Promise<void>;
  /** Refetch the adaptation (after an "already applied" or "not ready" refusal). */
  onRefetch: () => void;
  /** Move focus to the heading on mount (the run just finished). */
  focusOnMount?: boolean;
  /** The run's per-run token cap, when known (for "your token limit (N) was reached"). */
  tokenLimit?: number | null;
}

const ROW_META: Record<DiffRow['kind'], { label: string; icon: ReactElement }> = {
  kept: { label: 'Kept', icon: <KeptIcon fontSize="small" aria-hidden /> },
  swapped: { label: 'Swapped', icon: <SwappedIcon fontSize="small" aria-hidden /> },
  added: { label: 'Added', icon: <AddedIcon fontSize="small" aria-hidden /> },
  dropped: { label: 'Dropped', icon: <DroppedIcon fontSize="small" aria-hidden /> },
};

function DiffItem({ row }: { row: DiffRow }) {
  const meta = ROW_META[row.kind];
  return (
    <Box component="li" data-testid={`diff-${row.kind}`} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Chip size="small" variant="outlined" icon={meta.icon} label={meta.label} sx={{ flexShrink: 0, minWidth: 92 }} />
      <Box sx={{ minWidth: 0 }}>
        {row.kind === 'swapped' ? (
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
            <span>{row.fromName}</span>
            <ArrowIcon fontSize="small" aria-hidden />
            <Box component="span" sx={visuallyHidden}>
              replaced by
            </Box>
            <span>{row.name}</span>
          </Typography>
        ) : (
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere', textDecoration: row.kind === 'dropped' ? 'line-through' : 'none' }}>
            {row.name}
          </Typography>
        )}
        {row.kind === 'dropped' ? (
          <Chip size="small" label={`Reason: ${DROP_REASON_LABEL[row.reason]}`} sx={{ mt: 0.5 }} />
        ) : (
          <Typography variant="body2">
            {'before' in row && row.before && row.before !== row.after ? `${row.before} → ${row.after}` : row.after}
          </Typography>
        )}
        {'note' in row && row.note && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {row.note}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function Bullets({ id, title, items }: { id: string; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Box component="section" aria-labelledby={id}>
      <Typography id={id} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {items.map((item, i) => (
          <Typography component="li" variant="body2" key={i} sx={{ overflowWrap: 'anywhere' }}>
            {item}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

function CriticVerdict({ adaptation }: { adaptation: AdaptationView }) {
  const report = adaptation.criticReport;
  if (!report || report.skipped || report.verdict === null) {
    return <Chip size="small" variant="outlined" label={NOT_REVIEWED} data-testid="critic-verdict" />;
  }
  const label = report.verdict === 'accept' ? 'Critic: accepted' : 'Critic: asked for changes';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={report.verdict === 'accept' ? 'success' : 'warning'}
      icon={report.verdict === 'accept' ? <KeptIcon aria-hidden /> : undefined}
      label={report.rounds > 1 ? `${label} (${report.rounds} rounds)` : label}
      data-testid="critic-verdict"
    />
  );
}

export function AdaptationReview({
  adaptation,
  planned,
  canApplyWorkout,
  canApplyPlan,
  onApplyWorkout,
  onApplyPlan,
  onDiscard,
  onAdjustAgain,
  onStartPlanned,
  onCopyExercises,
  onRefetch,
  focusOnMount = false,
  tokenLimit = null,
}: AdaptationReviewProps) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [mode, setMode] = useState<ApplyMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [planDone, setPlanDone] = useState<{ versionNumber: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApplyProblem | null>(null);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
  }, [focusOnMount]);

  if (adaptation.status === 'blocked_safety') {
    return (
      <Alert severity="warning" data-testid="adapt-guidance">
        <AlertTitle>Stopped for safety</AlertTitle>
        {adaptation.guidance ??
          'Something you described needs attention from a qualified professional before training. No model was called.'}
      </Alert>
    );
  }

  const proposal = adaptation.proposal;
  if (!proposal) return null;

  const rows = buildAdaptationDiff(proposal, planned);
  const report = adaptation.guardrailReport;
  const requested = typeof adaptation.request.minutes === 'number' ? adaptation.request.minutes : null;
  const estimated = report?.estimatedMinutes ?? proposal.estimatedMinutes;
  const notes = [
    ...(report?.repairs ?? []).map((f) => f.message),
    ...(report?.rejected ?? []).map((f) => f.message),
    ...(report?.warnings ?? []).map((w) => WARNING_TEXT[w]).filter((w): w is string => !!w),
  ];
  const ready = adaptation.status === 'ready';
  const noBase = adaptation.baseRef === null;
  const planDisabledReason = noBase
    ? 'There was no planned workout today, so there is no plan to update.'
    : !canApplyPlan
      ? "Your role can't change plans."
      : null;

  const fail = (err: unknown) => {
    const next = applyProblemOf(err);
    setProblem(next);
    if (next.kind === 'already_applied' || next.kind === 'not_ready') onRefetch();
  };

  const confirm = async () => {
    if (!mode) return;
    setBusy(true);
    setProblem(null);
    try {
      if (mode === 'workout') {
        const result = await onApplyWorkout();
        setMode(null);
        navigate(`/train/workouts/${encodeURIComponent(result.workoutId)}`, {
          state: result.planChanged ? { notice: PLAN_CHANGED_NOTICE } : undefined,
        });
        return;
      }
      const result = await onApplyPlan();
      setPlanDone({ versionNumber: result.versionNumber });
    } catch (err) {
      setMode(null);
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartPlanned();
    } catch (err) {
      setStartError(err instanceof Error && err.message ? err.message : "Couldn't start the workout");
      setStarting(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onDiscard();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setCopying(true);
    try {
      await onCopyExercises();
    } catch (err) {
      setProblem({ kind: 'other', message: err instanceof Error && err.message ? err.message : "Couldn't open the logger" });
    } finally {
      setCopying(false);
    }
  };

  const problemAction = (() => {
    if (!problem) return undefined;
    switch (problem.kind) {
      case 'workout_in_progress':
        return problem.id ? (
          <Button color="inherit" size="small" component={RouterLink} to={`/train/workouts/${encodeURIComponent(problem.id)}`}>
            Resume
          </Button>
        ) : undefined;
      case 'stale':
        return (
          <Button color="inherit" size="small" onClick={onAdjustAgain}>
            Adjust again
          </Button>
        );
      case 'in_progress':
        return problem.id ? (
          <Button color="inherit" size="small" component={RouterLink} to={`/train/adapt/${encodeURIComponent(problem.id)}`}>
            Open it
          </Button>
        ) : undefined;
      case 'ai_disabled':
        return canApplyWorkout ? (
          <Button color="inherit" size="small" onClick={() => void copy()} disabled={copying}>
            Copy exercises
          </Button>
        ) : undefined;
      default:
        return undefined;
    }
  })();

  return (
    <Box data-testid="adaptation-review">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }} useFlexGap>
        <Chip size="small" color="secondary" icon={<AiIcon aria-hidden />} label="AI" aria-label="Made by AI" />
        <Typography ref={headingRef} tabIndex={-1} variant="h5" component="h2" sx={{ overflowWrap: 'anywhere', outline: 'none' }}>
          {proposal.title}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {DRAFT_NOTICE}
      </Typography>
      <Typography sx={{ mb: 1.5, overflowWrap: 'anywhere' }}>{proposal.summary}</Typography>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }} useFlexGap>
        <Typography variant="body2" data-testid="adapt-minutes">
          About {estimated} min{requested !== null ? ` (you asked for ${requested} min)` : ''}
        </Typography>
        {report && !report.fitsRequest && requested !== null && (
          <Typography variant="body2" color="warning.main">
            Longer than you asked
          </Typography>
        )}
        <CriticVerdict adaptation={adaptation} />
      </Stack>

      {adaptation.criticReport?.skipped === 'token_cap' && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="critic-skipped-token-cap">
          {notReviewedTokenCapText(tokenLimit)}. It still passed the safety, time and equipment checks.
        </Alert>
      )}

      {adaptation.status === 'applied' && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          action={
            adaptation.appliedWorkoutId ? (
              <Button color="inherit" size="small" component={RouterLink} to={`/train/workouts/${encodeURIComponent(adaptation.appliedWorkoutId)}`}>
                Open workout
              </Button>
            ) : undefined
          }
        >
          {adaptation.appliedAs === 'plan_change' ? 'Your plan was updated with this workout.' : 'Used for today.'}
        </Alert>
      )}
      {adaptation.status === 'discarded' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You discarded this adjusted workout.
        </Alert>
      )}

      <Card variant="outlined" component="section" aria-labelledby="adapt-diff-heading" sx={{ mb: 2 }}>
        <CardContent>
          <Typography id="adapt-diff-heading" variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {noBase ? 'The workout' : 'Compared with your planned workout'}
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {rows.map((row) => (
              <DiffItem key={row.key} row={row} />
            ))}
          </Box>
        </CardContent>
      </Card>

      <Stack spacing={2}>
        <Bullets id="adapt-why" title="Why" items={proposal.rationale} />
        <Bullets id="adapt-assumed" title="What was assumed" items={proposal.uncertainty} />
        <Bullets id="adapt-notes" title="Checks made these changes" items={notes} />
      </Stack>

      {problem && (
        <Alert severity="warning" role="alert" sx={{ mt: 2 }} action={problemAction} data-testid={`apply-problem-${problem.kind}`}>
          {problem.message}
        </Alert>
      )}

      {ready && (
        <Box
          role="group"
          aria-label="What to do with it"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 3, '& > *': { minHeight: 44, width: { xs: '100%', sm: 'auto' } } }}
        >
          {canApplyWorkout && (
            <Button variant="contained" onClick={() => setMode('workout')} disabled={busy}>
              Use for today only
            </Button>
          )}
          <Tooltip title={planDisabledReason ?? ''} disableHoverListener={!planDisabledReason}>
            <span style={{ display: 'inline-flex' }}>
              <Button
                variant="outlined"
                onClick={() => setMode('plan')}
                disabled={busy || !!planDisabledReason}
                aria-describedby={planDisabledReason ? 'adapt-plan-disabled' : undefined}
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                Update my plan
              </Button>
            </span>
          </Tooltip>
          <Button onClick={() => void discard()} disabled={busy}>
            Discard
          </Button>
          <Button onClick={onAdjustAgain} disabled={busy}>
            Adjust again
          </Button>
        </Box>
      )}
      {ready && planDisabledReason && (
        <Typography id="adapt-plan-disabled" variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {planDisabledReason}
        </Typography>
      )}
      {!ready && adaptation.status !== 'applied' && (
        <Box sx={{ mt: 3 }}>
          <Button onClick={onAdjustAgain}>Adjust again</Button>
        </Box>
      )}

      <ApplyDialog
        mode={mode}
        busy={busy}
        planDone={planDone}
        canStart={canApplyWorkout}
        starting={starting}
        startError={startError}
        onConfirm={() => void confirm()}
        onStart={() => void start()}
        onClose={() => {
          setMode(null);
          setPlanDone(null);
          setStartError(null);
        }}
      />
    </Box>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export default AdaptationReview;
