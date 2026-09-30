/**
 * Run limits for the training agents: the per-run token cap and the critic
 * rounds, stored as `ai.training` in the user settings document, plus the
 * API's estimate for a typical plan (`POST /api/ai/training/estimate`).
 *
 * The bounds shown come from the API (`limits` on `GET /api/ai/training/models`)
 * and the PATCH enforces them; the check here only saves a round trip.
 * Tokens only: no price is ever shown, since there is no price catalogue.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { TrainingModelsView, TrainingRunEstimate } from '../../services/trainingAgents';
import type { AiTrainingLimits } from '../../types';

const DEFAULT_CRITIC_ROUNDS = 2;

const formatTokens = (value: number) => value.toLocaleString('en-US');

export interface TrainingRunLimitsProps {
  value: AiTrainingLimits | undefined;
  limits: TrainingModelsView['limits'] | undefined;
  estimate: TrainingRunEstimate | null;
  estimateError?: string | null;
  /** Persist the limits (`null` clears a field). Rejects on failure. */
  onSave: (next: { maxRunTokens: number | null; maxCriticRounds: 1 | 2 | 3 }) => Promise<void>;
  disabled?: boolean;
}

export function TrainingRunLimits({
  value,
  limits,
  estimate,
  estimateError,
  onSave,
  disabled = false,
}: TrainingRunLimitsProps) {
  const savedTokens = value?.maxRunTokens ?? null;
  const savedRounds = value?.maxCriticRounds ?? DEFAULT_CRITIC_ROUNDS;
  const [tokens, setTokens] = useState(savedTokens === null ? '' : String(savedTokens));
  const [rounds, setRounds] = useState<1 | 2 | 3>(savedRounds);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTokens(savedTokens === null ? '' : String(savedTokens));
    setRounds(savedRounds);
  }, [savedTokens, savedRounds]);

  const min = limits?.minRunTokens ?? 10_000;
  const max = limits?.hardMaxRunTokens ?? 2_000_000;
  const defaultCap = limits?.defaultRunTokens.create;

  const trimmed = tokens.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const invalid =
    parsed !== null && (!Number.isInteger(parsed) || parsed < min || parsed > max);

  const dirty = parsed !== savedTokens || rounds !== savedRounds;

  const handleSave = async () => {
    if (invalid) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await onSave({ maxRunTokens: parsed, maxCriticRounds: rounds });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the run limits');
    } finally {
      setSaving(false);
    }
  };

  const busy = disabled || saving;

  return (
    <Card component="section" aria-labelledby="training-run-limits-title">
      <CardContent>
        <Typography id="training-run-limits-title" variant="h6" component="h2" gutterBottom>
          Run limits
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A run stops when it reaches its token cap.
        </Typography>

        <Stack spacing={2}>
          <TextField
            size="small"
            fullWidth
            label="Max tokens per run"
            inputMode="numeric"
            value={tokens}
            onChange={(event) => {
              setSaved(false);
              setTokens(event.target.value);
            }}
            placeholder={defaultCap !== undefined ? formatTokens(defaultCap) : undefined}
            disabled={busy}
            error={invalid}
            helperText={
              invalid
                ? `Enter a whole number from ${formatTokens(min)} to ${formatTokens(max)}, or leave it blank.`
                : `Blank uses the default${defaultCap !== undefined ? ` (${formatTokens(defaultCap)} tokens)` : ''}.`
            }
          />

          <FormControl fullWidth size="small" disabled={busy}>
            <InputLabel id="training-critic-rounds-label">Critic rounds</InputLabel>
            <Select
              labelId="training-critic-rounds-label"
              label="Critic rounds"
              value={rounds}
              onChange={(event) => {
                setSaved(false);
                setRounds(Number(event.target.value) as 1 | 2 | 3);
              }}
            >
              <MenuItem value={1}>1</MenuItem>
              <MenuItem value={2}>2 (default)</MenuItem>
              <MenuItem value={3}>3</MenuItem>
            </Select>
          </FormControl>

          {estimate && (
            <Box>
              <Typography variant="body2">
                Estimated tokens for a typical plan: {formatTokens(estimate.tokens.low)} to{' '}
                {formatTokens(estimate.tokens.high)}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p">
                An estimate, not a quote. Cap per run: {formatTokens(estimate.cap)} tokens.
              </Typography>
              {estimate.capBinding && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  A run may stop at your cap of {formatTokens(estimate.cap)} tokens before it
                  finishes.
                </Alert>
              )}
            </Box>
          )}
          {estimateError && <Alert severity="warning">{estimateError}</Alert>}

          <Box>
            <Button variant="contained" onClick={() => void handleSave()} disabled={busy || invalid || !dirty}>
              Save limits
            </Button>
          </Box>

          {saved && <Alert severity="success">Run limits saved.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default TrainingRunLimits;
