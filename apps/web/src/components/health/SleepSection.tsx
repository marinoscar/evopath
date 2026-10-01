/**
 * "Sleep" on the Health page (#283 scope update, epic #276): the last 14
 * nights from `GET /api/sleep`, newest first, each with its asleep time and a
 * stacked bar of the stages the phone reported (awake, light, deep, REM).
 * Sessions synced from Health Connect carry the source label.
 *
 * Mounted inside the Health overview, which renders only for
 * `health_data:read` (the string `GET /api/sleep` enforces). Display only:
 * every minute count is the API's.
 */
import { useId } from 'react';
import { Alert, Box, Button, Chip, List, ListItem, Skeleton, Typography } from '@mui/material';
import { useSleep } from '../../hooks/useSleep';
import {
  SLEEP_NIGHTS_SHOWN,
  SLEEP_STAGES,
  SLEEP_STAGE_LABELS,
  formatSleepDuration,
  isHealthConnectSleep,
  sleepStages,
  type SleepSession,
  type SleepStage,
} from '../../services/sleep';
import { formatDayLabel } from '../../utils/localDates';
import { useChartSeries } from '../../theme/chartPalette';
import { HEALTH_CONNECT_LABEL } from '../goals/HealthConnectChip';

const FALLBACK_COLORS: Record<SleepStage, string> = {
  awake: '#e0a030',
  light: '#7fb3d5',
  deep: '#1f4e79',
  rem: '#8e6cc0',
  unknown: '#9e9e9e',
};

function useStageColors(): Record<SleepStage, string> {
  const series = useChartSeries();
  if (series.length < 4) return FALLBACK_COLORS;
  return { awake: series[3], light: series[1], deep: series[0], rem: series[2], unknown: series[4] ?? '#9e9e9e' };
}

function StageBar({ session, colors }: { session: SleepSession; colors: Record<SleepStage, string> }) {
  const stages = sleepStages(session);
  const total = stages.reduce((sum, [, minutes]) => sum + minutes, 0);
  if (total === 0) return null;
  const description = stages.map(([stage, minutes]) => `${SLEEP_STAGE_LABELS[stage]} ${formatSleepDuration(minutes)}`).join(', ');
  return (
    <Box
      role="img"
      aria-label={`Stages: ${description}`}
      data-testid={`sleep-stages-${session.id}`}
      sx={{ display: 'flex', height: 10, borderRadius: 1, overflow: 'hidden', width: '100%', bgcolor: 'action.hover' }}
    >
      {stages.map(([stage, minutes]) => (
        <Box
          key={stage}
          data-stage={stage}
          sx={{ width: `${(minutes / total) * 100}%`, bgcolor: colors[stage] }}
        />
      ))}
    </Box>
  );
}

export function SleepSection({ timeZone }: { timeZone: string | null | undefined }) {
  const headingId = useId();
  const colors = useStageColors();
  const { sessions, to, isLoading, error, refresh } = useSleep(timeZone);

  let body;
  if (isLoading && sessions.length === 0) {
    body = (
      <Box data-testid="sleep-loading">
        <Skeleton width="60%" />
        <Skeleton width="40%" />
      </Box>
    );
  } else if (error && sessions.length === 0) {
    body = (
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
    );
  } else if (sessions.length === 0) {
    body = (
      <Typography color="text.secondary">
        No sleep recorded in the last {SLEEP_NIGHTS_SHOWN} nights. The Android app syncs sleep from Health Connect.
      </Typography>
    );
  } else {
    const used = new Set(sessions.flatMap((s) => sleepStages(s).map(([stage]) => stage)));
    body = (
      <>
        <List dense disablePadding aria-label={`Sleep, last ${SLEEP_NIGHTS_SHOWN} nights`}>
          {sessions.map((session) => (
            <ListItem key={session.id} disableGutters divider sx={{ display: 'block' }} data-testid={`sleep-${session.id}`}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 96 }}>
                  {formatDayLabel(session.localDate, to)}
                </Typography>
                <Typography variant="body2">{formatSleepDuration(session.durationMinutes)} asleep</Typography>
                {isHealthConnectSleep(session) && (
                  <Chip size="small" variant="outlined" label={HEALTH_CONNECT_LABEL} data-testid="health-connect-chip" />
                )}
              </Box>
              <StageBar session={session} colors={colors} />
            </ListItem>
          ))}
        </List>
        {used.size > 0 && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }} aria-hidden="true">
            {SLEEP_STAGES.filter((stage) => used.has(stage)).map((stage) => (
              <Box key={stage} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: colors[stage] }} />
                <Typography variant="caption">{SLEEP_STAGE_LABELS[stage]}</Typography>
              </Box>
            ))}
          </Box>
        )}
      </>
    );
  }

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="h5" component="h2" gutterBottom>
        Sleep
      </Typography>
      {body}
    </Box>
  );
}

export default SleepSection;
