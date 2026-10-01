/**
 * The Engagement panel of `/admin/settings/coach` (E7.11, #251; spec §2.8,
 * §2.13): send, open and follow-through rates by message angle and persona,
 * plus the epic KPI tiles, from `GET /api/admin/coach/stats` (last 30 days).
 *
 * THE API DECIDES. Every count and rate is computed server-side; this panel
 * only formats them. Aggregates only: no user, no message text.
 *
 * Empty state when nothing was sent in the window (no invented numbers);
 * an error shows a Retry.
 */
import type { ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import { EmptyState } from '../common/EmptyState';
import { useCoachStats } from '../../hooks/useCoachStats';
import {
  COACH_ANGLE_LABELS,
  COACH_MOMENT_LABELS,
  COACH_PERSONA_LABELS,
  type CoachFunnelRow,
  type CoachMoment,
} from '../../services/coach';

export const COACH_STATS_WINDOW_DAYS = 30;

const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A rate as a percentage, or an em dash (read as "not available"). */
function Rate({ value }: { value: number | null }) {
  if (value === null) return <span aria-label="Not available">—</span>;
  return <>{percent.format(value)}</>;
}

function angleLabel(key: string): string {
  return key === 'none' ? 'No angle' : (COACH_ANGLE_LABELS[key] ?? key);
}

function personaLabel(key: string): string {
  return key === 'none' ? 'Unknown' : (COACH_PERSONA_LABELS[key] ?? key);
}

function momentLabel(key: string): string {
  return COACH_MOMENT_LABELS[key as CoachMoment] ?? key;
}

interface KpiTileProps {
  label: string;
  value: ReactNode;
  help: string;
}

function KpiTile({ label, value, help }: KpiTileProps) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }} component="li">
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" component="p" sx={{ my: 0.5 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {help}
      </Typography>
    </Paper>
  );
}

interface FunnelTableProps {
  id: string;
  title: string;
  firstColumn: string;
  rows: CoachFunnelRow[];
  label: (key: string) => string;
}

function FunnelTable({ id, title, firstColumn, rows, label }: FunnelTableProps) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography id={id} variant="subtitle1" component="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-labelledby={id}>
          <TableHead>
            <TableRow>
              <TableCell scope="col">{firstColumn}</TableCell>
              <TableCell scope="col" align="right">
                Sent
              </TableCell>
              <TableCell scope="col" align="right">
                Opened
              </TableCell>
              <TableCell scope="col" align="right">
                Followed through
              </TableCell>
              <TableCell scope="col" align="right">
                Thumbs up
              </TableCell>
              <TableCell scope="col" align="right">
                Thumbs down
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell component="th" scope="row">
                  {label(row.key)}
                </TableCell>
                <TableCell align="right">{row.sent}</TableCell>
                <TableCell align="right">
                  <Rate value={row.openRate} />
                </TableCell>
                <TableCell align="right">
                  <Rate value={row.convertRate} />
                </TableCell>
                <TableCell align="right">{row.up}</TableCell>
                <TableCell align="right">{row.down}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export function CoachEngagementPanel() {
  const { stats, isLoading, error, refresh } = useCoachStats(COACH_STATS_WINDOW_DAYS);

  let content: ReactNode;
  if (error) {
    content = (
      <Alert
        severity="error"
        sx={{ mt: 2 }}
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  } else if (!stats) {
    content = (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
        <CircularProgress size={28} aria-label="Loading engagement stats" />
      </Box>
    );
  } else if (stats.totals.sent === 0) {
    content = (
      <EmptyState
        Icon={InsightsOutlinedIcon}
        headingLevel="h3"
        title="No engagement data yet"
        description="Send, open and follow-through rates by persona and message type will appear here once the coach starts sending messages."
      />
    );
  } else {
    const { kpis } = stats;
    content = (
      <Box aria-busy={isLoading} sx={{ mt: 1 }}>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Last {stats.range.days} days, {stats.totals.sent} messages sent. Counts only; no individual user is shown.
        </Typography>
        <Box
          component="ul"
          aria-label="Coach KPIs"
          sx={{
            listStyle: 'none',
            p: 0,
            m: 0,
            mb: 3,
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(5, minmax(0, 1fr))' },
          }}
        >
          <KpiTile label="Nudge open rate" value={<Rate value={kpis.nudgeOpenRate} />} help="Opened of sent" />
          <KpiTile
            label="Follow-through"
            value={<Rate value={kpis.conversionRate} />}
            help="Did the thing within 24 hours (48 for photos)"
          />
          <KpiTile
            label="Chat sessions per active user"
            value={kpis.chatSessionsPerWau === null ? <Rate value={null} /> : decimal.format(kpis.chatSessionsPerWau)}
            help={`${kpis.weeklyActiveUsers} active in the last week`}
          />
          <KpiTile
            label="Photo cadence kept"
            value={<Rate value={kpis.photoCadenceAdherencePct === null ? null : kpis.photoCadenceAdherencePct / 100} />}
            help="Users on their progress-photo schedule"
          />
          <KpiTile
            label="Opt-out rate"
            value={<Rate value={kpis.optOutRate} />}
            help={`${kpis.optedOut} turned the coach off`}
          />
        </Box>
        <Box sx={{ display: 'grid', gap: 3 }}>
          <FunnelTable
            id="coach-engagement-by-angle"
            title="By message angle"
            firstColumn="Angle"
            rows={stats.byAngle}
            label={angleLabel}
          />
          <FunnelTable
            id="coach-engagement-by-persona"
            title="By persona"
            firstColumn="Persona"
            rows={stats.byPersona}
            label={personaLabel}
          />
          <FunnelTable
            id="coach-engagement-by-moment"
            title="By moment"
            firstColumn="Moment"
            rows={stats.byMoment}
            label={momentLabel}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Paper
      component="section"
      aria-labelledby="coach-admin-engagement-title"
      sx={{ p: { xs: 2, sm: 3 }, mt: 3 }}
      data-testid="coach-engagement-panel"
    >
      <Typography id="coach-admin-engagement-title" variant="h6" component="h2">
        Engagement
      </Typography>
      {content}
    </Paper>
  );
}
