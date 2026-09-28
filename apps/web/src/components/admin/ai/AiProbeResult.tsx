/**
 * The result of an AI provider probe (`POST /admin/ai/providers/:p/test`) —
 * issue #429, epic #419. Mirrors the storage page's test result.
 *
 * ⚠ THE PROBE ANSWERS 200 FOR A BAD KEY. The verdict is `success` and each
 * check's `status`, never the HTTP status, so this component is the only
 * place a failed key is reported — as an ERROR alert with one row per check.
 *
 * ONE ROW PER CHECK, never a rolled-up verdict: "the key was accepted but
 * listing models failed" and "the key was refused" need different fixes, and
 * the `code` chip is the word an operator searches the runbook for.
 */

import { Alert, AlertTitle, Box, Chip, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlined';
import type { AiProbeCheck, AiProbeResult as AiProbeResultData } from '../../../services/ai';

const CHECK_ICONS = {
  passed: <CheckCircleIcon color="success" fontSize="small" titleAccess="Passed" />,
  failed: <ErrorOutlineIcon color="error" fontSize="small" titleAccess="Failed" />,
  skipped: <RemoveCircleOutlineIcon color="disabled" fontSize="small" titleAccess="Skipped" />,
} as const;

/** The extra sentence that turns a code into an action, or `null` when `detail` already says it. */
function remedyFor(check: AiProbeCheck): string | null {
  switch (check.code) {
    case 'AI_KEY_INVALID':
      return 'The provider refused this key. Check it was copied whole, and that it has not been revoked.';
    case 'AI_RATE_LIMITED':
      return 'The provider is rate-limiting this key. Wait a minute and test again.';
    case 'AI_PROVIDER_UNAVAILABLE':
      return 'Nothing answered at the provider. Check the base URL, and that this deployment can reach it.';
    default:
      return null;
  }
}

function CheckRow({ check }: { check: AiProbeCheck }) {
  const remedy = check.status === 'failed' ? remedyFor(check) : null;

  return (
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }} data-testid={`ai-check-${check.id}`}>
      <Box sx={{ pt: 0.25 }}>{CHECK_ICONS[check.status]}</Box>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">{check.label}</Typography>
          {check.code && (
            <Chip
              size="small"
              variant="outlined"
              label={check.code}
              data-testid={`ai-check-code-${check.id}`}
              color={
                check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'default'
              }
            />
          )}
        </Stack>
        {check.detail && (
          <Typography variant="body2" color="text.secondary">
            {check.detail}
          </Typography>
        )}
        {remedy && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {remedy}
          </Typography>
        )}
        {/* VERBATIM, wrapping rather than truncating — the provider's own
            words are the diagnosis. */}
        {check.error && (
          <Box
            component="pre"
            data-testid={`ai-check-error-${check.id}`}
            sx={{
              m: 0,
              mt: 1,
              fontFamily: 'monospace',
              fontSize: '0.8125rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {check.error}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export interface AiProbeResultProps {
  result: AiProbeResultData;
  onClose?: () => void;
}

export function AiProbeResult({ result, onClose }: AiProbeResultProps) {
  return (
    <Alert
      severity={result.success ? 'success' : 'error'}
      onClose={onClose}
      data-testid="ai-test-result"
    >
      <AlertTitle>
        {result.success ? 'The provider accepted this key' : 'The provider test did not pass'}
      </AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {result.provider} ·{' '}
        {result.usedStoredKey ? 'tested with the stored key' : 'tested with the key typed above'}
        {result.modelCount !== null && ` · ${result.modelCount} models visible`}
        {result.smokeModelId && ` · smoke test on ${result.smokeModelId}`}
      </Typography>
      <Stack spacing={1.5} sx={{ mt: 1 }}>
        {result.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </Stack>
    </Alert>
  );
}
