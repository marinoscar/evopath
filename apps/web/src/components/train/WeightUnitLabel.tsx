/**
 * "Weights in lb · Change" (E4.3). The unit is the Health Profile's unit
 * system; there is no toggle here, only the way to where it is set.
 */
import { Link as RouterLink } from 'react-router-dom';
import { Link, Typography } from '@mui/material';
import type { WeightUnit } from '../../utils/units';

export const HEALTH_PROFILE_PATH = '/settings/health-profile';

export function WeightUnitLabel({ unit }: { unit: WeightUnit }) {
  return (
    <Typography variant="body2" color="text.secondary">
      Weights in {unit}.{' '}
      <Link component={RouterLink} to={HEALTH_PROFILE_PATH} underline="hover">
        Change units
      </Link>
    </Typography>
  );
}
