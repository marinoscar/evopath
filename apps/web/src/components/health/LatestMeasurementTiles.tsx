/**
 * The latest value of each body and vital metric, as tiles (issue #53, E2.3):
 * Weight, Body fat, Waist, Blood pressure (the systolic/diastolic pair) and
 * Resting heart rate, plus a calculated BMI tile when weight and height exist.
 *
 * Values arrive canonical from `GET /api/measurements/latest` and are shown in
 * the user's unit system through the catalog's factors. Deltas are neutral:
 * an arrow and a number in `text.secondary`, never green or red.
 */

import { Box, Card, CardContent, Chip, Grid, Link, Skeleton, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { LatestItem, MeasurementDto, MetricCatalog, MetricDef, MetricKey, UnitSystem } from '../../services/health';
import { UNSPECIFIED_METHOD } from '../../services/health';
import { bmi, displayUnit, formatMeasurement, measurementDelta } from '../../utils/measurementUnits';
import { formatTakenAt } from '../../utils/measurementDates';
import { MeasurementTile, ValueWithUnit, type TileDelta } from './MeasurementTile';

const TILE_SIZE = { xs: 12, sm: 6, md: 4 } as const;

interface SingleTileDef {
  key: MetricKey;
  label: string;
  logLabel: string;
}

/** The single-metric tiles around the blood-pressure pair, in display order. */
const TILES_BEFORE_BP: readonly SingleTileDef[] = [
  { key: 'weight', label: 'Weight', logLabel: 'Log weight' },
  { key: 'body_fat_pct', label: 'Body fat', logLabel: 'Log body fat' },
  { key: 'waist_circumference', label: 'Waist', logLabel: 'Log waist' },
];
const TILES_AFTER_BP: readonly SingleTileDef[] = [
  { key: 'resting_hr', label: 'Resting heart rate', logLabel: 'Log resting heart rate' },
];

export interface LatestMeasurementTilesProps {
  catalog: MetricCatalog;
  items: LatestItem[];
  unitSystem: UnitSystem;
  /** From the health profile; `null` hides the BMI value and offers "Add your height". */
  heightMm: number | null;
  /** `health_data:write`. */
  canLog: boolean;
  onLog: (metric: MetricKey) => void;
  /** Reference instant for "Today" / "3 days ago" (tests, screenshots). */
  now?: Date;
}

export function LatestMeasurementTiles({
  catalog,
  items,
  unitSystem,
  heightMm,
  canLog,
  onLog,
  now,
}: LatestMeasurementTilesProps) {
  const metrics = new Map(catalog.metrics.map((metric) => [metric.key, metric]));
  const methodLabels = new Map(catalog.methods.map((method) => [method.key, method.label]));
  const byKey = new Map(items.map((item) => [item.metricKey, item]));

  const methodLabel = (reading: MeasurementDto) =>
    reading.method === UNSPECIFIED_METHOD ? null : (methodLabels.get(reading.method) ?? reading.method);

  const deltaOf = (metric: MetricDef, item: LatestItem | undefined, label?: string): TileDelta | null => {
    if (!item?.latest || !item.previous) return null;
    return { ...measurementDelta(metric, item.latest.value, item.previous.value, unitSystem), label };
  };

  const single = ({ key, label, logLabel }: SingleTileDef) => {
    const metric = metrics.get(key);
    const item = byKey.get(key);
    const reading = item?.latest ?? null;
    return (
      <Grid key={key} size={TILE_SIZE}>
        <MeasurementTile
          label={label}
          value={metric && reading ? formatMeasurement(metric, reading.value, unitSystem, { withUnit: false }) : null}
          unit={metric ? displayUnit(metric, unitSystem) : undefined}
          takenAt={reading?.measuredAt}
          method={reading ? methodLabel(reading) : null}
          delta={metric ? deltaOf(metric, item) : null}
          onLog={() => onLog(key)}
          canLog={canLog}
          logLabel={logLabel}
          now={now}
        />
      </Grid>
    );
  };

  const bloodPressure = () => {
    const sysMetric = metrics.get('bp_systolic');
    const diaMetric = metrics.get('bp_diastolic');
    const sysItem = byKey.get('bp_systolic');
    const diaItem = byKey.get('bp_diastolic');
    const sys = sysItem?.latest ?? null;
    const dia = diaItem?.latest ?? null;
    const common = {
      label: 'Blood pressure',
      onLog: () => onLog('bp_systolic'),
      canLog,
      logLabel: 'Log blood pressure',
      now,
    };

    if (!sysMetric || !diaMetric || (!sys && !dia)) {
      return <MeasurementTile {...common} value={null} />;
    }

    const unit = displayUnit(sysMetric, unitSystem);

    if (sys && dia && sys.entryId === dia.entryId) {
      const deltas = [deltaOf(sysMetric, sysItem, 'Systolic'), deltaOf(diaMetric, diaItem, 'Diastolic')].filter(
        (d): d is TileDelta => d !== null,
      );
      return (
        <MeasurementTile
          {...common}
          value={`${formatMeasurement(sysMetric, sys.value, unitSystem, { withUnit: false })}/${formatMeasurement(
            diaMetric,
            dia.value,
            unitSystem,
            { withUnit: false },
          )}`}
          unit={unit}
          takenAt={sys.measuredAt}
          method={methodLabel(sys)}
          delta={deltas}
        />
      );
    }

    // The pair's latest readings belong to different entries: each on its own line, with its own date.
    const lines = [
      { name: 'Systolic', metric: sysMetric, reading: sys },
      { name: 'Diastolic', metric: diaMetric, reading: dia },
    ];
    return (
      <MeasurementTile {...common}>
        {lines.map(({ name, metric, reading }) => (
          <Typography key={name} variant="body1">
            {name}{' '}
            {reading ? (
              <>
                <Box component="span" sx={{ fontWeight: 600 }}>
                  {formatMeasurement(metric, reading.value, unitSystem)}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {' · '}
                  {formatTakenAt(reading.measuredAt, now)}
                </Box>
              </>
            ) : (
              <Box component="span" sx={{ color: 'text.secondary' }}>
                No data yet
              </Box>
            )}
          </Typography>
        ))}
      </MeasurementTile>
    );
  };

  const bmiTile = () => {
    const weight = byKey.get('weight')?.latest;
    if (!weight) return null;
    const value = bmi(weight.value, heightMm);
    return (
      <Grid key="bmi" size={TILE_SIZE}>
        <MeasurementTile label="BMI">
          {value !== null ? (
            <>
              <ValueWithUnit value={value.toFixed(1)} />
              <Typography variant="body2" color="text.secondary">
                Calculated from weight and height
              </Typography>
              <Chip size="small" variant="outlined" label="Calculated" sx={{ mt: 1 }} />
            </>
          ) : (
            <Typography color="text.secondary">
              <Link component={RouterLink} to="/settings/health-profile">
                Add your height
              </Link>{' '}
              to see your BMI.
            </Typography>
          )}
        </MeasurementTile>
      </Grid>
    );
  };

  return (
    <Grid container spacing={2}>
      {TILES_BEFORE_BP.map(single)}
      <Grid key="blood-pressure" size={TILE_SIZE}>
        {bloodPressure()}
      </Grid>
      {TILES_AFTER_BP.map(single)}
      {bmiTile()}
    </Grid>
  );
}

/** Placeholder tiles while the catalog, the profile or the latest values load. */
export function LatestMeasurementTilesSkeleton() {
  return (
    <Grid container spacing={2} data-testid="latest-measurements-skeleton">
      {Array.from({ length: 5 }, (_, i) => (
        <Grid key={i} size={TILE_SIZE}>
          <Card variant="outlined">
            <CardContent>
              <Skeleton width="40%" />
              <Skeleton variant="text" sx={{ fontSize: '2rem' }} width="60%" />
              <Skeleton width="30%" />
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}

export default LatestMeasurementTiles;
