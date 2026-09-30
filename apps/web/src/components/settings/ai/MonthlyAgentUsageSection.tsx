/**
 * "Agent usage" on Settings → AI Keys (`/settings/ai`), E6.3.
 *
 * What the training agents (researcher, planner, critic, coach) used in one
 * UTC month: totals, by role, by kind of run and by whose key paid, from
 * `GET /api/ai/training/usage?month=YYYY-MM`. A SECTION of the existing page
 * under `MyAiUsageSection`, never a card or a tab of its own (Settings UI
 * Pattern rules 1 and 2): it answers the same "what am I spending" question.
 *
 * Owns its own fetch, loading and error, so a failed read never blanks the
 * keys above. Tokens, not currency: the platform has no price list.
 */
import { useId, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { AiUsageTable, AiUsageTotals, formatCount } from '../../ai/usage';
import { useMonthlyAgentUsage } from '../../../hooks/useAgentUsage';
import {
  formatUsageMonth,
  selectableUsageMonths,
  type TrainingUsageBucket,
} from '../../../services/trainingUsage';
import type { AiUsageSeriesEntry, AiUsageTotals as AiTotals } from '../../../services/ai';
import {
  keySourceLabel,
  kindLabel,
  roleLabel,
} from '../../training/usage/agentUsageLabels';
import { TokensNotCurrencyNote } from '../../training/usage/TokensNotCurrencyNote';

/** Persistence keys for `user_settings.dataTables`. */
export const AGENT_USAGE_ROLE_TABLE_ID = 'user-agent-usage-by-role';
export const AGENT_USAGE_KIND_TABLE_ID = 'user-agent-usage-by-kind';
export const AGENT_USAGE_KEY_TABLE_ID = 'user-agent-usage-by-key';

function toEntry(key: string, label: string, bucket: TrainingUsageBucket): AiUsageSeriesEntry {
  return {
    key,
    label,
    requests: bucket.requests,
    failed: bucket.failed,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    reasoningTokens: bucket.reasoningTokens,
    cachedInputTokens: bucket.cachedInputTokens,
    units: {},
  };
}

function toTotals(bucket: TrainingUsageBucket): AiTotals {
  return {
    ...toEntry('total', 'Total', bucket),
    orgKeyRequests: bucket.orgKeyRequests,
    orgKeyInputTokens: bucket.orgKeyInputTokens,
    orgKeyOutputTokens: bucket.orgKeyOutputTokens,
  };
}

function SubHeading({ id, children }: { id: string; children: string }) {
  return (
    <Typography id={id} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
      {children}
    </Typography>
  );
}

export interface MonthlyAgentUsageSectionProps {
  /** Tests pin "now" so the month list is stable. */
  now?: Date;
}

export function MonthlyAgentUsageSection({ now }: MonthlyAgentUsageSectionProps = {}) {
  const months = useMemo(() => selectableUsageMonths(now ?? new Date()), [now]);
  const [month, setMonth] = useState(months[0]);
  const { report, isLoading, error } = useMonthlyAgentUsage(month);
  const ids = { title: useId(), role: useId(), kind: useId(), key: useId() };
  const monthName = formatUsageMonth(month);

  const rows = useMemo(() => {
    if (!report) return null;
    return {
      role: report.byRole.map((r) => toEntry(r.role, roleLabel(r.role), r)),
      kind: report.byKind.map((r) =>
        toEntry(r.kind, `${kindLabel(r.kind)} (${formatCount(r.runs)} ${r.runs === 1 ? 'run' : 'runs'})`, r),
      ),
      key: report.byKeySource.map((r) => {
        const label = keySourceLabel(r.keySource);
        return toEntry(r.keySource, label.charAt(0).toUpperCase() + label.slice(1), r);
      }),
    };
  }, [report]);

  return (
    <Card component="section" aria-labelledby={ids.title} data-testid="monthly-agent-usage">
      <CardContent>
        <Typography id={ids.title} variant="h6" component="h2" gutterBottom>
          Agent usage
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          What your training agents used in one month, by role, by kind of run and by whose key paid. Months are
          counted in UTC days, like the rest of your usage.
        </Typography>

        <TextField
          select
          label="Month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          size="small"
          sx={{ mb: 2, minWidth: 200, width: { xs: '100%', sm: 'auto' } }}
        >
          {months.map((m) => (
            <MenuItem key={m} value={m}>
              {formatUsageMonth(m)}
            </MenuItem>
          ))}
        </TextField>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* A month change shows the spinner, never the previous month's numbers under the new name. */}
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} aria-label="Loading your agent usage" />
          </Box>
        ) : report && rows ? (
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            {report.totals.requests === 0 ? (
              <Typography variant="body2" color="text.secondary" data-testid="monthly-agent-usage-empty">
                Your agents made no requests in {monthName}.
              </Typography>
            ) : (
              <>
                <AiUsageTotals totals={toTotals(report.totals)} label={`Agent usage totals for ${monthName}`} />
                {report.totals.orgKeyRequests > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    {formatCount(report.totals.orgKeyRequests)} of these requests used the organisation&apos;s key.
                  </Typography>
                )}

                <Box component="section" aria-labelledby={ids.role} sx={{ minWidth: 0 }}>
                  <SubHeading id={ids.role}>By role</SubHeading>
                  <AiUsageTable
                    rows={rows.role}
                    keyLabel="Role"
                    tableId={AGENT_USAGE_ROLE_TABLE_ID}
                    ariaLabel={`Agent usage by role, ${monthName}`}
                    emptyText="No usage by role this month."
                    data-testid="agent-usage-by-role"
                  />
                </Box>
                <Box component="section" aria-labelledby={ids.kind} sx={{ minWidth: 0 }}>
                  <SubHeading id={ids.kind}>By kind of run</SubHeading>
                  <AiUsageTable
                    rows={rows.kind}
                    keyLabel="Kind of run"
                    tableId={AGENT_USAGE_KIND_TABLE_ID}
                    ariaLabel={`Agent usage by kind of run, ${monthName}`}
                    emptyText="No runs this month."
                    data-testid="agent-usage-by-kind"
                  />
                </Box>
                <Box component="section" aria-labelledby={ids.key} sx={{ minWidth: 0 }}>
                  <SubHeading id={ids.key}>By whose key paid</SubHeading>
                  <AiUsageTable
                    rows={rows.key}
                    keyLabel="Key"
                    tableId={AGENT_USAGE_KEY_TABLE_ID}
                    ariaLabel={`Agent usage by key, ${monthName}`}
                    emptyText="No usage by key this month."
                    data-testid="agent-usage-by-key"
                  />
                </Box>
              </>
            )}
            {report.retention.partial && (
              <Typography variant="body2" color="text.secondary" data-testid="monthly-agent-usage-partial">
                Usage older than {report.retention.retentionDays} days is removed, so part of {monthName} may be
                missing.
              </Typography>
            )}
            <TokensNotCurrencyNote />
          </Stack>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default MonthlyAgentUsageSection;
