/**
 * An open proposal (E5.8, "Ask me first"): a `proposed` change log entry with
 * its summary, rationale, one readable line per operation, the sources, the
 * expiry, and **Approve** / **Reject**.
 *
 * The decision resumes the paused run (`POST /api/ai/training/runs/:runId/decision`),
 * so it needs AI on and `ai:use`; without them the buttons are replaced by
 * the explanation. The API re-checks the plan version on approve: a plan that
 * changed meanwhile ends the proposal as superseded.
 */
import { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import type { ChangeLogEntry } from '../../services/programs';
import { trainingRefusalOf, TRAINING_REFUSALS } from '../../services/trainingAgents';
import { formatLongDate } from '../../utils/localDates';
import { CitationLinks, OperationLines } from './changeLogParts';

/** A proposal expires 14 days after it was made (the run's approval window). */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function proposalExpiresAt(entry: Pick<ChangeLogEntry, 'createdAt'>): string {
  return new Date(Date.parse(entry.createdAt) + PROPOSAL_TTL_MS).toISOString();
}

export interface ProposalCardProps {
  entry: ChangeLogEntry;
  /** AI is on and the caller holds `ai:use`: the decision can be sent. */
  aiVisible: boolean;
  /** `programs:write`. */
  canWrite: boolean;
  onDecide: (decision: 'approve' | 'reject') => Promise<unknown>;
}

function decisionError(err: unknown): string {
  const refusal = trainingRefusalOf(err);
  if (refusal?.reason === TRAINING_REFUSALS.NOT_AWAITING_DECISION) return 'This suggestion was already decided or has expired.';
  if (refusal?.reason === TRAINING_REFUSALS.RUN_ACTIVE) return 'Your coach is busy with another run. Try again shortly.';
  return err instanceof Error && err.message ? err.message : 'That did not work';
}

export function ProposalCard({ entry, aiVisible, canWrite, onDecide }: ProposalCardProps) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const expiresAt = proposalExpiresAt(entry);
  const expired = Date.parse(expiresAt) <= Date.now();

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await onDecide(decision);
      setDone(decision === 'approve' ? 'Approved. Your plan is being updated.' : 'Rejected. Your plan stays as it is.');
    } catch (err) {
      setError(decisionError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card variant="outlined" component="section" aria-labelledby={`proposal-${entry.id}`} data-testid="proposal-card">
      <CardContent>
        <Typography id={`proposal-${entry.id}`} variant="h6" component="h2" gutterBottom>
          Your coach suggests a change
        </Typography>
        <Typography sx={{ overflowWrap: 'anywhere' }}>{entry.summary}</Typography>
        {entry.rationale && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {entry.rationale}
          </Typography>
        )}
        <OperationLines operations={entry.operations} label="Suggested changes" />
        <CitationLinks citations={entry.citations} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="proposal-expiry">
          {expired ? 'This suggestion has expired.' : `Open until ${formatLongDate(expiresAt.slice(0, 10))}.`}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
        {done ? (
          <Alert severity="success" sx={{ mt: 1 }}>
            {done}
          </Alert>
        ) : !aiVisible ? (
          <Alert severity="info" sx={{ mt: 1 }}>
            AI is switched off (or not available to you), so this suggestion cannot be decided now. It stays open until it
            expires.
          </Alert>
        ) : canWrite && !expired ? (
          <Box sx={{ mt: 1.5 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button variant="contained" onClick={() => void decide('approve')} disabled={busy !== null} sx={{ minHeight: 44 }}>
                Approve
              </Button>
              <Button variant="outlined" onClick={() => void decide('reject')} disabled={busy !== null} sx={{ minHeight: 44 }}>
                Reject
              </Button>
            </Stack>
          </Box>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default ProposalCard;
