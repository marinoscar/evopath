/**
 * Weekly hard sets against planned sets, one small chart per primary muscle
 * (E5.9). Each muscle's summary and data table carry the same numbers.
 */
import { Box, Typography, useTheme } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';
import { useChartSeries } from '../../theme/chartPalette';
import type { MuscleVolume } from '../../services/programs';
import { formatWeight, type WeightUnit } from '../../utils/units';
import { ChartFrame, weekLabel } from './ChartFrame';

export interface VolumeByMuscleProps {
  volume: MuscleVolume[];
  weightUnit: WeightUnit;
  /** Fixed width per chart; tests only. */
  width?: number;
}

/** `upper_back` -> "Upper back". */
export function muscleLabel(muscle: string): string {
  const text = muscle.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function VolumeByMuscle({ volume, weightUnit, width }: VolumeByMuscleProps) {
  const theme = useTheme();
  const palette = useChartSeries();
  // "Planned" is the muted reference bar: the theme's outline ink, legible on
  // paper in both schemes without being a series colour or a status.
  const plannedColor = theme.palette.outline;

  if (volume.length === 0) {
    return (
      <Typography color="text.secondary">No hard sets or planned sets in this range.</Typography>
    );
  }

  const swatch = (color: string) => (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: 0.5,
        bgcolor: color,
        mr: 0.75,
        verticalAlign: 'middle',
      }}
    />
  );

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {swatch(plannedColor)}Planned sets{'  '}
        <Box component="span" sx={{ ml: 2 }}>
          {swatch(palette[1])}Hard sets
        </Box>
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
        }}
      >
        {volume.map((m) => {
          const name = muscleLabel(m.muscle);
          const planned = m.weeks.reduce((sum, w) => sum + w.plannedSets, 0);
          const tonnage = m.tonnageKg === null ? null : formatWeight(m.tonnageKg, weightUnit);
          return (
            <Box key={m.muscle} sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" component="h3">
                {name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {m.totalHardSets} hard of {planned} planned sets
                {tonnage ? ` · ${tonnage} moved` : ''}
              </Typography>
              <ChartFrame
                summary={`${name}: ${m.totalHardSets} hard sets against ${planned} planned sets over ${m.weeks.length} weeks.`}
                tableLabel={`${name} weekly sets`}
                columns={['Week of', 'Planned sets', 'Hard sets']}
                rows={m.weeks.map((w) => [weekLabel(w.weekStart), w.plannedSets, w.hardSets])}
              >
                <BarChart
                  height={140}
                  width={width}
                  skipAnimation
                  hideLegend
                  xAxis={[
                    {
                      scaleType: 'band',
                      data: m.weeks.map((w) => weekLabel(w.weekStart)),
                      tickLabelStyle: { fontSize: 10 },
                    },
                  ]}
                  yAxis={[{ min: 0, width: 28, tickMinStep: 1 }]}
                  series={[
                    {
                      id: 'planned',
                      label: 'Planned sets',
                      data: m.weeks.map((w) => w.plannedSets),
                      color: plannedColor,
                    },
                    {
                      id: 'hard',
                      label: 'Hard sets',
                      data: m.weeks.map((w) => w.hardSets),
                      color: palette[1],
                    },
                  ]}
                  margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                />
              </ChartFrame>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
