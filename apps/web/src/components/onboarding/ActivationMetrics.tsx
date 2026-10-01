/**
 * The Activation section of the Setup guide — issue #212.
 *
 * A section of `/admin/settings/setup`, not a card or a tab of its own (the
 * Settings UI Pattern): the setup guide answers "can people succeed here?",
 * and activation is the measured answer. Same permission as the page and the
 * endpoint, `system_settings:read`.
 *
 * For the users who signed up in the chosen window (7, 30 or 90 days):
 *
 * - **New users**, the cohort;
 * - **Activation rate**: of the users whose first 7 days are over, the share
 *   who completed a workout within them;
 * - **Median time to first workout**, over the cohort users who have one;
 * - a per-step funnel (health profile, gym, first workout, AI plan).
 *
 * Every number is written out as text ("12 of 40, 30%"); the progress bars
 * only repeat it, so nothing depends on colour. The API computes every value
 * from aggregates; nothing per-user is shown or fetched.
 */
import { useId, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useOnboardingMetrics } from '../../hooks/useOnboardingMetrics';
import {
  ONBOARDING_METRICS_WINDOWS,
  type OnboardingMetrics,
  type OnboardingMetricsStepId,
  type OnboardingMetricsWindow,
} from '../../services/onboarding';

export const ACTIVATION_HEADING = 'Activation';
export const EMPTY_COHORT_TEXT = 'No new users in this window';
const DEFAULT_WINDOW: OnboardingMetricsWindow = 30;

export const METRICS_STEP_LABEL: Record<OnboardingMetricsStepId, string> = {
  health_profile: 'Completed the health profile',
  gym: 'Added a gym',
  first_workout: 'Logged a first workout',
  ai_plan: 'Created an AI training plan',
};

/** `0.304` → `30%`; `null` → `null`. */
export function formatRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `${Math.round(rate * 100)}%`;
}

/** Hours as words: under two days in hours, otherwise in days. */
export function formatHours(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours)) return null;
  if (hours < 1) return 'Under 1 hour';
  if (hours < 48) {
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="h5" sx={{ m: 0, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
      <Typography component="dd" variant="body2" color="text.secondary" sx={{ m: 0 }}>
        {detail}
      </Typography>
    </Paper>
  );
}

function MetricsBody({ metrics }: { metrics: OnboardingMetrics }) {
  const funnelId = useId();
  if (metrics.cohortSize === 0) {
    return <Typography color="text.secondary">{EMPTY_COHORT_TEXT}.</Typography>;
  }
  const rate = formatRate(metrics.activationRate);
  const median = formatHours(metrics.medianHoursToFirstWorkout);
  const activationDays = metrics.activationWindowDays;

  return (
    <Stack spacing={3}>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
        }}
      >
        <StatTile
          label="New users"
          value={String(metrics.cohortSize)}
          detail={`Signed up in the last ${plural(metrics.windowDays, 'day', 'days')}`}
        />
        <StatTile
          label={`Activation rate (${activationDays}-day)`}
          value={rate ?? 'Not yet'}
          detail={
            metrics.eligible === 0
              ? `No one has passed their first ${plural(activationDays, 'day', 'days')} yet`
              : `${metrics.activated} of ${plural(metrics.eligible, 'eligible user', 'eligible users')} logged a workout within ${plural(activationDays, 'day', 'days')}`
          }
        />
        <StatTile
          label="Median time to first workout"
          value={median ?? 'No workouts yet'}
          detail={median ? 'From sign-up, for new users who have logged one' : 'No new user has logged a workout'}
        />
      </Box>

      <Box>
        <Typography id={funnelId} variant="subtitle1" component="h3" gutterBottom>
          Steps completed by new users
        </Typography>
        <Stack component="ul" aria-labelledby={funnelId} spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {metrics.steps.map((step) => {
            const label = METRICS_STEP_LABEL[step.id] ?? step.id;
            const pct = formatRate(step.rate);
            const text = `${step.completed} of ${metrics.cohortSize}${pct ? `, ${pct}` : ''}`;
            return (
              <Box component="li" key={step.id}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 2 }}>
                  <Typography variant="body2">{label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {text}
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(100, Math.max(0, (step.rate ?? 0) * 100))}
                  aria-label={`${label}: ${text}`}
                  sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
                />
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Stack>
  );
}

export function ActivationMetrics() {
  const headingId = useId();
  const [days, setDays] = useState<OnboardingMetricsWindow>(DEFAULT_WINDOW);
  const { metrics, isLoading, error, refresh } = useOnboardingMetrics(days);

  return (
    <Box component="section" aria-labelledby={headingId} aria-busy={isLoading} sx={{ mt: 4 }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          mb: 1,
        }}
      >
        <Typography id={headingId} variant="h5" component="h2">
          {ACTIVATION_HEADING}
        </Typography>
        <ToggleButtonGroup
          value={days}
          exclusive
          size="small"
          aria-label="Window"
          onChange={(_event, next: OnboardingMetricsWindow | null) => {
            if (next !== null) setDays(next);
          }}
        >
          {ONBOARDING_METRICS_WINDOWS.map((value) => (
            <ToggleButton key={value} value={value} aria-label={`Last ${value} days`} sx={{ minHeight: 44, px: 1.5 }}>
              {value} days
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        How people who signed up recently reached their first completed workout. Counts only; no
        individual is shown.
      </Typography>

      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : metrics ? (
        <MetricsBody metrics={metrics} />
      ) : (
        <Stack spacing={1} data-testid="activation-loading" aria-label="Loading activation metrics">
          <Skeleton variant="rounded" height={88} />
          <Skeleton variant="rounded" height={120} />
        </Stack>
      )}
    </Box>
  );
}

export default ActivationMetrics;
