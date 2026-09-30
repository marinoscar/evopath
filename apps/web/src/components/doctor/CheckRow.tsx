/**
 * One Doctor check, rendered as a row — issue #634.
 *
 * Modelled on the per-check rows of the storage connection test
 * (`pages/Admin/StorageConfigPage.tsx`) and the AI provider probe
 * (`components/admin/ai/AiProbeResult.tsx`): status icon, label, a status chip,
 * the detail line, the remedy as its own sentence, and the underlying error
 * VERBATIM in a `<pre>` — wrapping rather than truncating, because a provider
 * error's codes and quoted names are the diagnosis.
 *
 * When the check names a `settingsPath`, an "Open settings" link takes the
 * admin straight to the page that fixes it.
 */

import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlined';
import { Link as RouterLink } from 'react-router-dom';
import type { DoctorCheckReport, DoctorStatus } from '../../services/doctor';

export const STATUS_LABELS: Record<DoctorStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skip: 'Skipped',
};

export const STATUS_CHIP_COLORS: Record<DoctorStatus, ChipProps['color']> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
  skip: 'default',
};

export function StatusIcon({ status }: { status: DoctorStatus }) {
  const title = STATUS_LABELS[status];
  switch (status) {
    case 'pass':
      return <CheckCircleIcon color="success" fontSize="small" titleAccess={title} />;
    case 'warn':
      return <WarningAmberIcon color="warning" fontSize="small" titleAccess={title} />;
    case 'fail':
      return <ErrorOutlineIcon color="error" fontSize="small" titleAccess={title} />;
    default:
      return <RemoveCircleOutlineIcon color="disabled" fontSize="small" titleAccess={title} />;
  }
}

/** Probe timings are milliseconds to a few seconds; a short, readable form is enough. */
function formatCheckDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export interface CheckRowProps {
  check: DoctorCheckReport;
}

export function CheckRow({ check }: CheckRowProps) {
  return (
    <Box
      component="li"
      sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', listStyle: 'none' }}
      data-testid={`doctor-check-${check.id}`}
    >
      <Box sx={{ pt: 0.25, display: 'flex' }}>
        <StatusIcon status={check.status} />
      </Box>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
        >
          <Typography variant="subtitle2" component="h3">
            {check.label}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={STATUS_LABELS[check.status]}
            color={STATUS_CHIP_COLORS[check.status]}
            data-testid={`doctor-check-status-${check.id}`}
          />
          <Typography variant="caption" color="text.secondary">
            {formatCheckDuration(check.durationMs)}
          </Typography>
        </Stack>
        {check.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {check.detail}
          </Typography>
        )}
        {check.remedy && (
          <Typography
            variant="body2"
            sx={{ mt: 0.5 }}
            data-testid={`doctor-check-remedy-${check.id}`}
          >
            {check.remedy}
          </Typography>
        )}
        {check.error && (
          <Box
            component="pre"
            data-testid={`doctor-check-error-${check.id}`}
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
        {check.settingsPath && (
          <Button
            component={RouterLink}
            to={check.settingsPath}
            size="small"
            sx={{ mt: 0.5, ml: -0.5 }}
            aria-label={`Open settings for ${check.label}`}
          >
            Open settings
          </Button>
        )}
      </Box>
    </Box>
  );
}
