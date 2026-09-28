/**
 * The totals tiles for an AI usage report (issue #444) — the Job Insights
 * `Kpi` shape: a caption, a large value, an optional hint. Shared by the admin
 * AI Usage page and the user's "Usage" section.
 */
import { Paper, Stack, Typography } from '@mui/material';
import type { AiUsageTotals as Totals } from '../../../services/ai';
import { formatCount, formatFailureRate, formatUnits } from './aiUsageFormat';

interface TileProps {
  label: string;
  value: string;
  hint?: string;
}

export function AiUsageTile({ label, value, hint }: TileProps) {
  return (
    <Paper
      variant="outlined"
      sx={{ px: 2, py: 1.5, minWidth: { xs: 'calc(50% - 8px)', sm: 150 }, flexGrow: 1, flexBasis: 0 }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="h5" component="p" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

export interface AiUsageTotalsProps {
  totals: Totals;
  /** Accessible name for the group of tiles. */
  label: string;
}

export function AiUsageTotals({ totals, label }: AiUsageTotalsProps) {
  const units = formatUnits(totals.units);
  return (
    <Stack
      direction="row"
      spacing={2}
      useFlexGap
      role="group"
      aria-label={label}
      sx={{ flexWrap: 'wrap' }}
    >
      <AiUsageTile label="Requests" value={formatCount(totals.requests)} hint={units ?? undefined} />
      <AiUsageTile
        label="Failure rate"
        value={formatFailureRate(totals)}
        hint={`${formatCount(totals.failed)} failed`}
      />
      <AiUsageTile
        label="Input tokens"
        value={formatCount(totals.inputTokens)}
        hint={`${formatCount(totals.cachedInputTokens)} cached`}
      />
      <AiUsageTile label="Output tokens" value={formatCount(totals.outputTokens)} />
      <AiUsageTile label="Reasoning tokens" value={formatCount(totals.reasoningTokens)} />
    </Stack>
  );
}
