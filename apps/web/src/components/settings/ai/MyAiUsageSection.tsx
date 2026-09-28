/**
 * "Usage" on Settings → AI Keys (`/settings/ai`) — issue #444, epic #420.
 *
 * The caller's own consumption over the last 30 days, by model, from
 * `GET /api/ai/usage/me` (#443). A SECTION of the existing page, not a tab and
 * not a card of its own (Settings UI Pattern rule 2): it answers the same
 * question the rest of the page does — "what am I spending on my key" — and
 * sits under the keys and models it is about.
 *
 * Owns its own fetch, loading and error, like `UsableAiModelsList` beside it,
 * so a failed usage read never blanks the keys above.
 */
import { useMemo } from 'react';
import { Alert, Box, Card, CardContent, CircularProgress, Typography } from '@mui/material';
import { AiUsageTable, AiUsageTotals, formatCount } from '../../ai/usage';
import { useMyAiUsage } from '../../../hooks/useAiUsage';
import { AI_USAGE_DEFAULT_RANGE_DAYS, aiUsageRangeForDays } from '../../../services/ai';

/** Persistence key for `user_settings.dataTables`. */
export const MY_USAGE_TABLE_ID = 'user-ai-usage-by-model';

export function MyAiUsageSection() {
  const range = useMemo(() => aiUsageRangeForDays(AI_USAGE_DEFAULT_RANGE_DAYS), []);
  const { report, isLoading, error } = useMyAiUsage({ groupBy: 'model', ...range });

  return (
    <Card component="section" aria-labelledby="my-ai-usage-title">
      <CardContent>
        <Typography id="my-ai-usage-title" variant="h6" component="h2" gutterBottom>
          Usage
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Your requests over the last {AI_USAGE_DEFAULT_RANGE_DAYS} days, by model. Calls made with
          your own key are billed to your provider account.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {isLoading && !report ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} aria-label="Loading your AI usage" />
          </Box>
        ) : report && report.totals.requests === 0 ? (
          <Typography variant="body2" color="text.secondary">
            You haven&apos;t made any AI requests in the last {AI_USAGE_DEFAULT_RANGE_DAYS} days.
          </Typography>
        ) : report ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <AiUsageTotals totals={report.totals} label="Your AI usage totals" />
            {report.totals.orgKeyRequests > 0 && (
              <Typography variant="body2" color="text.secondary">
                {formatCount(report.totals.orgKeyRequests)} of these requests used your
                organization&apos;s key.
              </Typography>
            )}
            <AiUsageTable
              rows={report.series}
              keyLabel="Model"
              tableId={MY_USAGE_TABLE_ID}
              ariaLabel="Your usage by model"
              emptyText="No usage in this range."
              data-testid="my-ai-usage-table"
            />
          </Box>
        ) : null}
      </CardContent>
    </Card>
  );
}
