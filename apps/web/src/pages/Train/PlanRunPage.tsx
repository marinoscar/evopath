/**
 * Watch the agents make a plan (`/train/plans/runs/:runId`), E5.6.
 *
 * Follows the run over SSE (`useTrainingRun`): the stage stepper, the
 * sources the researcher verified, each draft's size, the guardrails'
 * repairs, the critic's scorecard per round and the tokens per agent. The
 * events carry identifiers, counts, codes and server-authored summaries
 * only, so no prompt text can appear here.
 *
 * Leaving never cancels the run; returning replays it. Routed behind
 * `ai:use` and AI being on.
 */
import { useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { useTrainingRun, type UseTrainingRunOptions } from '../../hooks/useTrainingRun';
import { TERMINAL_RUN_STATUSES, type TrainingRunStatus } from '../../services/trainingAgents';
import { ConfirmDialog } from '../../components/gyms/ConfirmDialog';
import { RunStageStepper } from '../../components/training/RunStageStepper';
import { SourceList } from '../../components/training/SourceList';
import { PlanDraftSummary } from '../../components/training/PlanDraftSummary';
import { GuardrailRepairs } from '../../components/training/GuardrailRepairs';
import { CriticScorecard } from '../../components/training/CriticScorecard';
import { UsageLine } from '../../components/training/UsageLine';
import { StickyActionBar } from '../../components/training/StickyActionBar';
import { runErrorCopy } from '../../components/training/runErrors';
import { warningText } from '../../components/training/planLabels';

/** A running run whose heartbeat is older than this shows the "waiting for the worker" banner. */
export const STALE_HEARTBEAT_MS = 3 * 60_000;

const STATUS_LABEL: Record<TrainingRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Waiting for you',
  interrupted: 'Interrupted',
  succeeded: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked_safety: 'Stopped for safety',
};

export interface PlanRunPageProps {
  /** Tests inject a fake stream. */
  runOptions?: UseTrainingRunOptions;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id}>
      <CardContent>
        <Typography id={id} variant="h6" component="h2" gutterBottom>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

export default function PlanRunPage({ runOptions }: PlanRunPageProps = {}) {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const { run, view, connection, error, notFound, lost, cancel, resume, reconnect } = useTrainingRun(runId, runOptions);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const back = (
    <Button component={RouterLink} to="/train/plans" startIcon={<BackIcon />} size="small" sx={{ mb: 1 }}>
      Plans
    </Button>
  );

  if (notFound) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          {back}
          <Alert severity="warning">This run does not exist, or it is not yours.</Alert>
        </Box>
      </Container>
    );
  }

  if (!run) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          {back}
          {error ? <Alert severity="error">{error}</Alert> : <Skeleton variant="rounded" height={160} />}
        </Box>
      </Container>
    );
  }

  // The row is authoritative once terminal; before that, the events are newer.
  const status: TrainingRunStatus = TERMINAL_RUN_STATUSES.includes(run.status) ? run.status : (view.status ?? run.status);
  const terminal = TERMINAL_RUN_STATUSES.includes(status);
  const working = status === 'queued' || status === 'running';
  const programId =
    view.finalized?.programId ||
    (typeof run.result?.programId === 'string' ? run.result.programId : null) ||
    run.programId;
  const warnings = [
    ...new Set([
      ...(view.finalized?.warnings ?? []),
      ...(Array.isArray(run.result?.warnings) ? (run.result.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : []),
    ]),
  ];
  const heartbeatStale =
    status === 'running' && !!run.heartbeatAt && Date.now() - new Date(run.heartbeatAt).getTime() > STALE_HEARTBEAT_MS;
  const errorCopy = status === 'failed' ? runErrorCopy(view.failedCode ?? run.errorCode) : null;
  const tryAgainTo = run.kind === 'revise' && run.programId ? `/train/plans/${encodeURIComponent(run.programId)}` : '/train/plans/new';

  const doCancel = async () => {
    setActionError(null);
    await cancel();
  };

  const doResume = async () => {
    setActionError(null);
    try {
      await resume();
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : 'Could not resume the run');
    }
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {back}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }} useFlexGap>
          <Typography variant="h4" component="h1">
            {run.kind === 'revise' ? 'Revising your plan' : 'Making your plan'}
          </Typography>
          <Chip label={STATUS_LABEL[status]} data-testid="run-status" />
          {!terminal && connection === 'reconnecting' && (
            <Chip label="Reconnecting…" variant="outlined" size="small" data-testid="run-reconnecting" />
          )}
        </Stack>

        <Stack spacing={2}>
          {lost && !terminal && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={reconnect}>
                  Reconnect
                </Button>
              }
            >
              The live view stopped (your session may have expired; sign in again if Reconnect does not help). The run
              continues in the background.
            </Alert>
          )}
          {heartbeatStale && (
            <Alert severity="info" data-testid="worker-stale">
              Waiting for the worker to recover. The run resumes from its last completed step.
            </Alert>
          )}
          {actionError && <Alert severity="error">{actionError}</Alert>}

          {status === 'succeeded' && (
            <Alert
              severity="success"
              action={
                programId ? (
                  <Button color="inherit" component={RouterLink} to={`/train/plans/${encodeURIComponent(programId)}`}>
                    Review plan
                  </Button>
                ) : undefined
              }
            >
              <AlertTitle>Your plan is ready</AlertTitle>
              {warnings.length > 0 ? `Reviewed with open notes: ${warnings.map(warningText).join(' ')}` : 'Review it, edit anything, then activate it.'}
            </Alert>
          )}
          {errorCopy && (
            <Alert
              severity="error"
              data-testid="run-failed"
              action={
                <Stack direction="row" spacing={1}>
                  {errorCopy.action && (
                    <Button color="inherit" size="small" component={RouterLink} to={errorCopy.action.to}>
                      {errorCopy.action.label}
                    </Button>
                  )}
                  <Button color="inherit" size="small" onClick={() => navigate(tryAgainTo)}>
                    Try again
                  </Button>
                </Stack>
              }
            >
              <AlertTitle>{errorCopy.title}</AlertTitle>
              {errorCopy.body}
            </Alert>
          )}
          {status === 'cancelled' && (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" onClick={() => navigate(tryAgainTo)}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Run cancelled</AlertTitle>
              No plan was saved from this run.
            </Alert>
          )}
          {status === 'blocked_safety' && (
            <Alert severity="warning">
              <AlertTitle>Stopped for safety</AlertTitle>
              Something in the request needs attention from a qualified professional before training. No model was
              called.
            </Alert>
          )}
          {status === 'awaiting_approval' && (
            <Alert
              severity="info"
              action={
                programId ? (
                  <Button color="inherit" component={RouterLink} to={`/train/plans/${encodeURIComponent(programId)}`}>
                    Open the proposal
                  </Button>
                ) : undefined
              }
            >
              <AlertTitle>Waiting for your decision</AlertTitle>
              The coach proposed a change to your plan.
            </Alert>
          )}
          {status === 'interrupted' && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={() => void doResume()}>
                  Resume
                </Button>
              }
            >
              <AlertTitle>Interrupted</AlertTitle>
              The run stopped before it finished. Resume continues from the last completed step.
            </Alert>
          )}

          <Section id="stages-heading" title="Progress">
            <RunStageStepper view={view} run={run} active={working} />
          </Section>

          <Section id="sources-heading" title="Sources">
            <SourceList sources={view.sources} queries={view.queries} brief={view.brief} />
          </Section>

          <Section id="drafts-heading" title="Drafts">
            <PlanDraftSummary drafts={view.drafts} />
          </Section>

          <Section id="guardrails-heading" title="Safety checks">
            <GuardrailRepairs reports={view.guardrails} />
          </Section>

          <Section id="critic-heading" title="Critic">
            {view.critic.length === 0 ? (
              <Typography color="text.secondary">No review yet.</Typography>
            ) : (
              <Stack spacing={1.5}>
                {view.critic.map((round) => (
                  <CriticScorecard key={round.round} round={round} />
                ))}
              </Stack>
            )}
          </Section>

          <Section id="usage-heading" title="Usage">
            <UsageLine view={view} run={run} />
          </Section>
        </Stack>

        {!terminal && status !== 'interrupted' && (
          <StickyActionBar label="Run actions">
            <Button
              color="error"
              variant="outlined"
              onClick={() => setConfirmCancel(true)}
              disabled={run.cancelRequested}
              sx={{ minHeight: 44 }}
            >
              {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
            </Button>
          </StickyActionBar>
        )}
      </Box>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this run?"
        message="The agents stop within a few seconds and no plan is saved. Tokens already used are not refunded."
        confirmLabel="Stop the run"
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          await doCancel();
          setConfirmCancel(false);
        }}
      />
    </Container>
  );
}
