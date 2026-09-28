/**
 * Admin → AI → AI Usage (`/admin/settings/ai/usage`) — issue #444, epic #420.
 *
 * Who is calling AI, which models they use, and how much of it the
 * organisation's own key pays for — over `GET /api/admin/ai/usage` (#443).
 *
 * A REGISTRY CARD of its own, nested under the AI route (the Job Insights /
 * AI Models precedent: `settingsPageTitle`'s longest prefix titles it "AI
 * Usage"), and feature-gated like AI Models — usage of a switched-off platform
 * is a page about history, and the route sits behind `RequireAiEnabled`.
 *
 * TWO READS, ONE PER QUESTION. The API answers one grouping per call, so the
 * page asks twice: `groupBy=day` feeds the totals and the time series, and the
 * group-by selector drives the breakdown table (user, model, provider or key
 * source). Both share the range, so the totals always describe the table.
 *
 * Read-only: there is nothing to write, so `ai_config:read` (the card's and
 * the route's gate) is the only permission this page consults.
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Navigate } from 'react-router-dom';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import {
  AiUsageDailyChart,
  AiUsageTable,
  AiUsageTotals,
  fillDailySeries,
  formatCount,
} from '../../components/ai/usage';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiUsage } from '../../hooks/useAiUsage';
import {
  AI_USAGE_DEFAULT_RANGE_DAYS,
  AI_USAGE_RANGE_OPTIONS,
  aiUsageRangeForDays,
  type AiUsageGroupBy,
  type AiUsageRangeDays,
  type AiUsageTotals as Totals,
} from '../../services/ai';

/** Mirrors the `AI Usage` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'AI Usage';
const PAGE_DESCRIPTION =
  "See who is calling AI, which models they use, and how much of it the organization's key pays for.";

/** Persistence keys for `user_settings.dataTables`. Never derived from the route. */
export const BREAKDOWN_TABLE_ID = 'admin-ai-usage-breakdown';
export const DAILY_TABLE_ID = 'admin-ai-usage-daily';

type BreakdownGroupBy = Exclude<AiUsageGroupBy, 'day'>;

const BREAKDOWN_OPTIONS: { value: BreakdownGroupBy; label: string; column: string }[] = [
  { value: 'user', label: 'User', column: 'User' },
  { value: 'model', label: 'Model', column: 'Model' },
  { value: 'provider', label: 'Provider', column: 'Provider' },
  { value: 'keySource', label: 'Key source', column: 'Key source' },
];

/** `keySource` values as a reader says them. Unknown values render as themselves. */
const KEY_SOURCE_LABELS: Record<string, string> = {
  user: "User's own key",
  org: 'Organization key',
  admin_discovery: 'Catalog sync (admin key)',
  none: 'No key (keyless server)',
};

function OrgKeySummary({ totals }: { totals: Totals }) {
  const share =
    totals.requests > 0 ? `${((totals.orgKeyRequests / totals.requests) * 100).toFixed(1)}%` : '—';
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby="ai-usage-org-key-title"
      sx={{ p: 2, borderColor: 'primary.main', borderWidth: 2 }}
    >
      <Typography id="ai-usage-org-key-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
        Paid by organization key
      </Typography>
      <Typography variant="h5" component="p" sx={{ fontWeight: 600 }}>
        {formatCount(totals.orgKeyRequests)} requests
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {share} of all requests · {formatCount(totals.orgKeyInputTokens)} input tokens ·{' '}
        {formatCount(totals.orgKeyOutputTokens)} output tokens
      </Typography>
    </Paper>
  );
}

export default function AiUsagePage() {
  const { hasPermission } = usePermissions();
  const [rangeDays, setRangeDays] = useState<AiUsageRangeDays>(AI_USAGE_DEFAULT_RANGE_DAYS);
  const [groupBy, setGroupBy] = useState<BreakdownGroupBy>('user');
  const range = useMemo(() => aiUsageRangeForDays(rangeDays), [rangeDays]);

  const daily = useAiUsage({ groupBy: 'day', ...range });
  const breakdown = useAiUsage({ groupBy, ...range });

  const days = useMemo(() => (daily.report ? fillDailySeries(daily.report) : []), [daily.report]);
  const breakdownRows = useMemo(
    () =>
      (breakdown.report?.groupBy === groupBy ? breakdown.report.series : []).map((row) =>
        groupBy === 'keySource' ? { ...row, label: KEY_SOURCE_LABELS[row.key] ?? row.label } : row,
      ),
    [breakdown.report, groupBy],
  );

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook, so the hook order never changes.
  if (!hasPermission('ai_config:read')) {
    return <Navigate to="/" replace />;
  }

  const option = BREAKDOWN_OPTIONS.find((entry) => entry.value === groupBy) ?? BREAKDOWN_OPTIONS[0];
  const refresh = () => {
    void daily.refresh();
    void breakdown.refresh();
  };

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ mb: 3, alignItems: { xs: 'flex-start', sm: 'center' }, flexWrap: 'wrap' }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={rangeDays}
            aria-label="Date range"
            onChange={(_, next) => {
              if (next !== null) setRangeDays(next as AiUsageRangeDays);
            }}
          >
            {AI_USAGE_RANGE_OPTIONS.map((days) => (
              <ToggleButton key={days} value={days}>
                {days} days
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Button startIcon={<RefreshIcon />} onClick={refresh}>
            Refresh
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          {/* The API's OWN range, not the button pressed — it is what the numbers cover. */}
          {daily.report && (
            <Typography variant="caption" color="text.secondary">
              {daily.report.range.from.slice(0, 10)} to {daily.report.range.to.slice(0, 10)} (UTC)
            </Typography>
          )}
        </Stack>

        {daily.error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {daily.error}
          </Alert>
        )}

        {daily.isLoading && !daily.report ? (
          <LoadingSpinner />
        ) : daily.report ? (
          <Stack spacing={4}>
            {daily.report.totals.requests === 0 && (
              <Alert severity="info">No AI requests were made in this range.</Alert>
            )}

            <AiUsageTotals totals={daily.report.totals} label="AI usage totals" />

            <OrgKeySummary totals={daily.report.totals} />

            <Paper sx={{ p: 2, minWidth: 0 }}>
              <AiUsageDailyChart days={days} tableId={DAILY_TABLE_ID} idPrefix="admin-ai-usage" />
            </Paper>

            <Box component="section" aria-labelledby="ai-usage-breakdown-title" sx={{ minWidth: 0 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{ mb: 1.5, alignItems: { xs: 'stretch', sm: 'center' } }}
              >
                <Typography id="ai-usage-breakdown-title" variant="h6" component="h2" sx={{ flexGrow: 1 }}>
                  Usage by {option.label.toLowerCase()}
                </Typography>
                <TextField
                  select
                  size="small"
                  label="Group by"
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value as BreakdownGroupBy)}
                  sx={{ minWidth: 180 }}
                >
                  {BREAKDOWN_OPTIONS.map((entry) => (
                    <MenuItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              {breakdown.error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {breakdown.error}
                </Alert>
              )}
              <Paper sx={{ p: 2, minWidth: 0 }}>
                <AiUsageTable
                  rows={breakdownRows}
                  keyLabel={option.column}
                  tableId={BREAKDOWN_TABLE_ID}
                  ariaLabel={`Usage by ${option.label.toLowerCase()}`}
                  emptyText={
                    breakdown.isLoading ? 'Loading…' : 'No usage in this range.'
                  }
                  csvFilename={`ai-usage-by-${groupBy}`}
                  data-testid="admin-ai-usage-breakdown-table"
                />
              </Paper>
            </Box>
          </Stack>
        ) : null}
      </Box>
    </Container>
  );
}
