/**
 * "Ask the planner to change this": starts a `revise` run with the plan's
 * current version and the user's instruction (the browser sends only that;
 * prompts are built on the server). Rendered only for an AI-enabled user
 * with `ai:use`; disabled while a run is active or the agents are blocked.
 */
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Link, TextField } from '@mui/material';
import {
  ACTIVE_RUN_STATUSES,
  TRAINING_INTAKE_LIMITS,
  TRAINING_REFUSALS,
  listTrainingRuns,
  startTrainingRun,
  trainingRefusalOf,
} from '../../services/trainingAgents';
import type { TrainingBlocker } from '../../hooks/useTrainingAvailability';

export interface ReviseWithAiProps {
  programId: string;
  currentVersion: number;
  /** Why a revise run cannot start now (agents blocked), or null. */
  blocker: TrainingBlocker | null;
  /** Unsaved edits are open: revise works on the saved version. */
  disabledReason?: string | null;
}

const MAX = TRAINING_INTAKE_LIMITS.instructionChars;

export function ReviseWithAi({ programId, currentVersion, blocker, disabledReason = null }: ReviseWithAiProps) {
  const navigate = useNavigate();
  const [instruction, setInstruction] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTrainingRuns({ programId, pageSize: 5 })
      .then((page) => {
        if (cancelled) return;
        const active = page.items.find((run) => ACTIVE_RUN_STATUSES.includes(run.status));
        setActiveRunId(active?.id ?? null);
      })
      .catch(() => {
        // The start call refuses a second run anyway.
      });
    return () => {
      cancelled = true;
    };
  }, [programId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setGuidance(null);
    try {
      const started = await startTrainingRun({
        kind: 'revise',
        programId,
        basedOnVersion: currentVersion,
        instruction: instruction.trim(),
      });
      if (started.status === 'blocked_safety') {
        setGuidance(started.guidance ?? 'This request needs attention from a qualified professional first.');
        return;
      }
      navigate(`/train/plans/runs/${encodeURIComponent(started.runId)}`);
    } catch (err) {
      const refusal = trainingRefusalOf(err);
      if (refusal?.reason === TRAINING_REFUSALS.RUN_ACTIVE && typeof refusal.details.runId === 'string') {
        setActiveRunId(refusal.details.runId);
      } else if (refusal?.reason === TRAINING_REFUSALS.STALE_PLAN) {
        setError('The plan changed since you opened it. Reload the page and ask again.');
      } else {
        setError(err instanceof Error && err.message ? err.message : 'Could not start the revision');
      }
    } finally {
      setBusy(false);
    }
  };

  const reason = disabledReason ?? (activeRunId ? 'A plan run is in progress.' : blocker?.message ?? null);

  return (
    <Box>
      <TextField
        label="Ask the planner to change this"
        placeholder="For example: swap the Friday workout to Saturday and add more back work"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value.slice(0, MAX))}
        multiline
        minRows={2}
        fullWidth
        helperText={`${instruction.length}/${MAX}`}
        disabled={!!reason}
      />
      {reason && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {reason}{' '}
          {activeRunId && (
            <Link component={RouterLink} to={`/train/plans/runs/${encodeURIComponent(activeRunId)}`}>
              Open the run
            </Link>
          )}
          {!activeRunId && blocker?.fix && (
            <Link component={RouterLink} to={blocker.fix.to}>
              {blocker.fix.label}
            </Link>
          )}
        </Alert>
      )}
      {guidance && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {guidance}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      <Button
        variant="outlined"
        onClick={() => void submit()}
        disabled={busy || !!reason || instruction.trim().length === 0}
        sx={{ mt: 1, minHeight: 44 }}
      >
        Ask the planner
      </Button>
    </Box>
  );
}

export default ReviseWithAi;
