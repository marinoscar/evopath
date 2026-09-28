/**
 * The Telemetry Dashboard's headline tiles — issue #578, epic #576.
 *
 * One tile per `summary.tiles` entry (requests/min, 5xx rate, p95, error and
 * warning logs, last data), then the `runtime` tiles when the API sends them.
 * Each shows the value and unit, the change against the previous window of
 * equal length (▲/▼ and a percentage, coloured by whether that direction is
 * good or bad for the measure — never by colour alone), and a sparkline in
 * which a `null` bucket is a GAP, not a zero.
 *
 * Grid: 6 per row from `lg`, 3 from `sm`, 2 on phones.
 */
import { Box, Grid, Paper, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import type { DashboardTile } from '../../../services/telemetryDashboard';
import { formatTimestamp, formatTileValue, tileChange, tileDirection, type TileChange } from './format';

const TONE_COLOR: Record<TileChange['tone'], string> = {
  good: 'success.main',
  bad: 'error.main',
  neutral: 'text.secondary',
};

function ChangeLine({ change, compact }: { change: TileChange; compact: boolean }) {
  if (change.pct === null && change.trend === 'flat') {
    return (
      <Typography variant="caption" color="text.secondary">
        {compact ? '—' : 'No previous data'}
      </Typography>
    );
  }
  const pctText = change.pct === null ? 'new' : `${Math.abs(change.pct).toLocaleString()}%`;
  const words = change.trend === 'up' ? 'Up' : change.trend === 'down' ? 'Down' : 'Unchanged';
  const glyph = change.trend === 'up' ? '▲' : change.trend === 'down' ? '▼' : '=';
  const Icon = change.trend === 'up' ? ArrowUpwardIcon : change.trend === 'down' ? ArrowDownwardIcon : null;
  return (
    <Typography
      variant="caption"
      aria-label={`${words} ${pctText} vs previous window`}
      sx={{ color: TONE_COLOR[change.tone], display: 'inline-flex', alignItems: 'center', gap: 0.25, fontWeight: 500 }}
    >
      {compact && Icon ? <Icon aria-hidden sx={{ fontSize: 14 }} /> : <span aria-hidden>{glyph}</span>}
      <span aria-hidden>{pctText}</span>
      {!compact && (
        <Box component="span" aria-hidden sx={{ color: 'text.secondary', fontWeight: 400, ml: 0.5 }}>
          vs prev
        </Box>
      )}
    </Typography>
  );
}

function Sparkline({ data, height }: { data: (number | null)[]; height: number }) {
  const theme = useTheme();
  if (data.length < 2 || data.every((value) => value === null)) return <Box sx={{ height }} />;
  return (
    <Box aria-hidden sx={{ height, mt: 0.5 }}>
      {/* `SparkLineChart` is typed `number[]`, but hands `data` to a line
          series, which draws `null` as a gap — exactly what a bucket with
          nothing to measure is. */}
      <SparkLineChart
        data={data as number[]}
        height={height}
        color={theme.palette.primary.main}
        curve="linear"
      />
    </Box>
  );
}

function Tile({ tile, compact, now }: { tile: DashboardTile; compact: boolean; now: number }) {
  const formatted = formatTileValue(tile.value, tile.unit, now);
  const isTimestamp = tile.unit === 'timestamp';
  const change = tileChange(tile.value, tile.previous, tileDirection(tile.key));
  return (
    <Paper
      variant="outlined"
      data-testid={`tile-${tile.key}`}
      sx={{ p: { xs: 1.25, sm: 1.5 }, height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Typography variant="caption" color="text.secondary" noWrap title={tile.label} component="h3">
        {tile.label}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'baseline', minWidth: 0 }}>
        <Typography
          variant={compact ? 'h6' : 'h5'}
          component="p"
          noWrap
          title={isTimestamp && typeof tile.value === 'string' ? formatTimestamp(tile.value) : undefined}
          sx={{ fontWeight: 600, minWidth: 0 }}
        >
          {formatted.value}
        </Typography>
        {formatted.unit && (
          <Typography variant="body2" color="text.secondary" noWrap>
            {formatted.unit}
          </Typography>
        )}
      </Stack>
      {!isTimestamp && <ChangeLine change={change} compact={compact} />}
      <Box sx={{ mt: 'auto' }}>
        {!isTimestamp && <Sparkline data={tile.sparkline} height={compact ? 24 : 40} />}
      </Box>
    </Paper>
  );
}

export interface KpiTilesProps {
  tiles: DashboardTile[];
  runtime?: DashboardTile[];
  /** For relative timestamps; the page passes its clock. */
  now?: number;
}

export function KpiTiles({ tiles, runtime = [], now = Date.now() }: KpiTilesProps) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  return (
    <Grid container spacing={{ xs: 1, sm: 1.5 }} data-testid="kpi-tiles">
      {[...tiles, ...runtime].map((tile) => (
        <Grid key={tile.key} size={{ xs: 6, sm: 4, lg: 2 }} sx={{ minWidth: 0 }}>
          <Tile tile={tile} compact={compact} now={now} />
        </Grid>
      ))}
    </Grid>
  );
}
