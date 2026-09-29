import { useId, type ReactNode } from 'react';
import { Box, Card, CardActions, CardContent, Chip, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import RemoveIcon from '@mui/icons-material/Remove';
import type { MeasurementDelta } from '../../utils/measurementUnits';
import { formatTakenAt } from '../../utils/measurementDates';
import { LogMeasurementButton } from './LogMeasurementButton';

/** Screen-reader-only text (the MUI `visuallyHidden` recipe). */
export const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

export interface TileDelta extends MeasurementDelta {
  /** e.g. `Systolic` when a tile shows more than one delta. */
  label?: string;
}

export interface MeasurementTileProps {
  label: string;
  /** The formatted number, without its unit. `null`/absent → "No data yet". */
  value?: string | null;
  unit?: string;
  /** ISO instant of the reading. */
  takenAt?: string | null;
  /** The method's label; omitted (no chip) when the method is `unspecified`. */
  method?: string | null;
  delta?: TileDelta | TileDelta[] | null;
  /** Replaces the value block (the split blood-pressure tile, the BMI tile). */
  children?: ReactNode;
  /** Absent → no Log button (the BMI tile is calculated, never logged). */
  onLog?: () => void;
  canLog?: boolean;
  /** Accessible name of the Log button, e.g. "Log weight". */
  logLabel?: string;
  /** Reference instant for "Today" / "3 days ago". */
  now?: Date;
}

export function DeltaLine({ delta }: { delta: TileDelta }) {
  const Icon =
    delta.direction === 'up' ? ArrowUpwardIcon : delta.direction === 'down' ? ArrowDownwardIcon : RemoveIcon;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
        <Icon sx={{ fontSize: 16 }} />
        {delta.label ? `${delta.label} ${delta.text}` : delta.text}
      </Box>
      <Box component="span" sx={visuallyHiddenSx}>
        {delta.label ? `${delta.label} ${delta.spoken}` : delta.spoken}
      </Box>
    </Typography>
  );
}

/** A number with its unit: `208.4 lb`, `27.8%`. */
export function ValueWithUnit({ value, unit }: { value: string; unit?: string }) {
  return (
    <Typography variant="h5" component="p" sx={{ fontWeight: 600 }}>
      {value}
      {unit && (
        <Box component="span" sx={{ typography: 'body1', color: 'text.secondary' }}>
          {unit === '%' ? unit : ` ${unit}`}
        </Box>
      )}
    </Typography>
  );
}

/** One latest-value tile on the Health page (issue #53, E2.3). Neutral: no colour judges a value. */
export function MeasurementTile({
  label,
  value,
  unit,
  takenAt,
  method,
  delta,
  children,
  onLog,
  canLog = true,
  logLabel,
  now,
}: MeasurementTileProps) {
  const headingId = useId();
  const deltas = delta ? (Array.isArray(delta) ? delta : [delta]) : [];
  const hasValue = value !== null && value !== undefined;

  return (
    <Card
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardContent sx={{ flexGrow: 1 }}>
        <Typography id={headingId} variant="subtitle1" component="h2" color="text.secondary" gutterBottom>
          {label}
        </Typography>
        {children ??
          (hasValue ? (
            <>
              <ValueWithUnit value={value} unit={unit} />
              {takenAt && (
                <Typography variant="body2" color="text.secondary">
                  {formatTakenAt(takenAt, now)}
                </Typography>
              )}
              {deltas.map((d) => (
                <DeltaLine key={d.label ?? 'delta'} delta={d} />
              ))}
              {method && <Chip size="small" variant="outlined" label={method} sx={{ mt: 1 }} />}
            </>
          ) : (
            <Typography color="text.secondary">No data yet</Typography>
          ))}
      </CardContent>
      {onLog && (
        <CardActions>
          <LogMeasurementButton canLog={canLog} onClick={onLog} size="small" aria-label={logLabel}>
            Log
          </LogMeasurementButton>
        </CardActions>
      )}
    </Card>
  );
}

export default MeasurementTile;
