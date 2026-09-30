/**
 * The plan Progress view's body (E5.9): facts the server computed about a
 * plan over the last 4, 8, 12 or 26 weeks (`GET /api/training/signals`).
 * Nothing is derived here beyond formatting; weights arrive in kilograms and
 * are shown in the Health Profile unit. Works with AI off.
 *
 * Sections: range selector, KPI row (adherence, sessions per week, missed,
 * PRs), weekly adherence chart, volume per muscle, top lifts, effort, where
 * it hurt, readiness and body weight. A range without any training explains
 * itself instead of drawing empty charts; no plan links to `/train/plans`.
 */
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import {
  DEFAULT_SIGNALS_WEEKS,
  SIGNALS_RANGE_WEEKS,
  useSignals,
  type SignalsRangeWeeks,
} from '../../hooks/useSignals';
import type { PlanSignals, RpeTrend } from '../../services/programs';
import { formatLongDate } from '../../utils/localDates';
import { formatWeight, formatWeightNumber, type WeightUnit } from '../../utils/units';
import { EmptyState } from '../common/EmptyState';
import { AdherenceChart, formatPct } from './AdherenceChart';
import { PerformanceList } from './PerformanceList';
import { VolumeByMuscle } from './VolumeByMuscle';

export const NO_PLAN_TITLE = 'No training plan yet';
export const NO_DATA_IN_RANGE =
  'Nothing to show for these weeks yet: no planned session was due and no workout was logged. Pick a longer range or check back after your next workout.';

export interface SignalsSummaryProps {
  /** Omitted: the active program. */
  programId?: string;
  initialWeeks?: SignalsRangeWeeks;
  /** Fixed chart width; tests only (jsdom has no layout). */
  chartWidth?: number;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id}>
      <CardContent>
        <Typography id={id} variant="h6" component="h2" sx={{ mb: 1 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card variant="outlined" sx={{ minWidth: 0 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="body2" color="text.secondary" component="p">
          {label}
        </Typography>
        <Typography variant="h5" component="p">
          {value}
        </Typography>
        {detail && (
          <Typography variant="caption" color="text.secondary" component="p">
            {detail}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

const RPE_TREND_TEXT: Record<RpeTrend, string> = {
  rising: 'Rising: sessions feel harder',
  flat: 'Steady',
  falling: 'Falling: sessions feel easier',
  insufficient: 'Not enough sessions yet',
};

function signedWeight(kg: number, unit: WeightUnit): string {
  const text = formatWeight(Math.abs(kg), unit);
  if (Number(formatWeightNumber(Math.abs(kg), unit)) === 0) return `0 ${unit}`;
  return `${kg > 0 ? '+' : '−'}${text}`;
}

function score(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 10) / 10} of 5`;
}

function hasTraining(s: PlanSignals): boolean {
  return (
    s.adherence.totals.planned > 0 ||
    s.adherence.totals.extra > 0 ||
    s.frequency.perWeek.some((w) => w.sessions > 0) ||
    s.performance.length > 0 ||
    s.volume.some((m) => m.totalHardSets > 0)
  );
}

export function SignalsSummary({
  programId,
  initialWeeks = DEFAULT_SIGNALS_WEEKS,
  chartWidth,
}: SignalsSummaryProps) {
  const [weeks, setWeeks] = useState<SignalsRangeWeeks>(initialWeeks);
  const { signals, isLoading, error, notFound, forbidden, weightUnit, refresh } = useSignals({
    programId,
    weeks,
  });

  const rangeSelector = (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={weeks}
      onChange={(_, value: SignalsRangeWeeks | null) => value && setWeeks(value)}
      aria-label="Range"
      sx={{ flexWrap: 'wrap' }}
    >
      {SIGNALS_RANGE_WEEKS.map((w) => (
        <ToggleButton key={w} value={w} sx={{ minHeight: 44, minWidth: 44 }}>
          {w} weeks
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );

  if (forbidden)
    return <Alert severity="info">You don&apos;t have access to training plans.</Alert>;
  if (notFound) {
    return (
      <Alert
        severity="warning"
        action={
          <Button component={RouterLink} to="/train" color="inherit" size="small">
            Back to Train
          </Button>
        }
      >
        This plan was not found.
      </Alert>
    );
  }
  if (error && !isLoading) {
    return (
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
  }
  if (isLoading || !signals) {
    return (
      <Stack spacing={2} data-testid="signals-skeleton" aria-busy="true">
        {rangeSelector}
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="rounded" height={240} />
      </Stack>
    );
  }
  if (signals.programId === null) {
    return (
      <EmptyState
        Icon={InsightsOutlinedIcon}
        headingLevel="h2"
        title={NO_PLAN_TITLE}
        description="Progress appears here once you train from a plan."
        action={
          <Button component={RouterLink} to="/train/plans" variant="outlined">
            Create a plan
          </Button>
        }
      />
    );
  }

  const { adherence, frequency, effort, pain, readiness, body } = signals;
  const prs = signals.performance.filter((p) => p.prInRange).length;
  const year = Number(signals.asOf.slice(0, 4));
  const training = hasTraining(signals);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {rangeSelector}
        <Typography variant="body2" color="text.secondary">
          {formatLongDate(signals.range.from, year)} to {formatLongDate(signals.range.to, year)}
        </Typography>
      </Stack>

      {signals.planChangedOn && (
        <Alert severity="info">
          The plan changed on {formatLongDate(signals.planChangedOn, year)}; earlier weeks use
          today&apos;s structure.
        </Alert>
      )}
      {signals.truncated && (
        <Alert severity="info">
          Your history is long, so this view starts later than the range you picked.
        </Alert>
      )}

      <Box
        component="section"
        aria-label="Key numbers"
        sx={{
          display: 'grid',
          gap: 1,
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
        }}
      >
        <Kpi
          label="Adherence"
          value={formatPct(adherence.totals.adherencePct)}
          detail={`${adherence.totals.completed} of ${adherence.totals.planned} planned`}
        />
        <Kpi
          label="Sessions per week"
          value={
            frequency.avgPerWeek === null ? '—' : String(Math.round(frequency.avgPerWeek * 10) / 10)
          }
          detail="Full weeks, all workouts"
        />
        <Kpi
          label="Missed"
          value={String(adherence.totals.missed)}
          detail={`Streak: ${adherence.missedStreak}`}
        />
        <Kpi label="PRs in range" value={String(prs)} />
      </Box>

      {!training ? (
        <Alert severity="info">{NO_DATA_IN_RANGE}</Alert>
      ) : (
        <>
          <Section id="signals-adherence" title="Adherence">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {adherence.totals.completed} completed ({adherence.totals.partialSessions} partial),{' '}
              {adherence.totals.missed} missed, {adherence.totals.extra} extra · completed streak{' '}
              {adherence.completedStreak}, missed streak {adherence.missedStreak}. Weeks marked *
              are not complete.
            </Typography>
            <AdherenceChart adherence={adherence} width={chartWidth} />
          </Section>

          <Section id="signals-volume" title="Volume per muscle">
            <VolumeByMuscle volume={signals.volume} weightUnit={weightUnit} width={chartWidth} />
          </Section>

          <Section id="signals-lifts" title="Top lifts">
            <PerformanceList performance={signals.performance} weightUnit={weightUnit} />
          </Section>

          <Section id="signals-effort" title="Effort">
            <Typography>
              Average RPE {effort.avgRpe === null ? '—' : Math.round(effort.avgRpe * 10) / 10} ·{' '}
              {effort.setsAtRpe9Plus} {effort.setsAtRpe9Plus === 1 ? 'set' : 'sets'} at RPE 9 or
              more
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Trend: {RPE_TREND_TEXT[effort.rpeTrend]}
            </Typography>
          </Section>
        </>
      )}

      <Section id="signals-pain" title="Where it hurt">
        {pain.length === 0 ? (
          <Typography color="text.secondary">
            No sets flagged as painful in the last 28 days.
          </Typography>
        ) : (
          <List disablePadding>
            {pain.map((p) => (
              <ListItem key={p.exerciseId} divider disableGutters>
                <ListItemText
                  primary={p.name}
                  secondary={
                    `${p.flaggedSessions28d} ${p.flaggedSessions28d === 1 ? 'session' : 'sessions'} flagged in 28 days` +
                    (p.consecutiveFlaggedSessions > 1
                      ? `, the last ${p.consecutiveFlaggedSessions} in a row`
                      : '') +
                    ` · last on ${formatLongDate(p.lastFlaggedOn, year)}`
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
        }}
      >
        <Section id="signals-readiness" title="Readiness, last 7 days">
          {readiness.avg === null ? (
            <Typography color="text.secondary">No check-ins in the last 7 days.</Typography>
          ) : (
            <>
              <Typography variant="body2">
                Energy {score(readiness.avg.energy)} · Sleep {score(readiness.avg.sleepQuality)}
              </Typography>
              <Typography variant="body2">
                Soreness {score(readiness.avg.soreness)} · Stress {score(readiness.avg.stress)}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {readiness.lowDays} low {readiness.lowDays === 1 ? 'day' : 'days'} of{' '}
                {readiness.days}
                {readiness.lowStreak > 0 ? ` · ${readiness.lowStreak} in a row up to today` : ''}
              </Typography>
            </>
          )}
        </Section>
        <Section id="signals-body" title="Body weight">
          {body.weightKg.latest === null ? (
            <Typography color="text.secondary">No weight logged in the last 8 weeks.</Typography>
          ) : (
            <>
              <Typography>Latest {formatWeight(body.weightKg.latest, weightUnit)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {body.weightKg.changePerWeek === null
                  ? 'Log at least 3 weigh-ins to see a trend.'
                  : `Trend ${signedWeight(body.weightKg.changePerWeek, weightUnit)} per week over ${body.weightKg.points} weigh-ins`}
              </Typography>
            </>
          )}
          {body.bodyFatPct?.latest != null && (
            <Typography variant="body2" color="text.secondary">
              Body fat {Math.round(body.bodyFatPct.latest * 10) / 10}%
            </Typography>
          )}
        </Section>
      </Box>
    </Stack>
  );
}
