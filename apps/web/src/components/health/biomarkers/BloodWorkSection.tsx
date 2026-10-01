/**
 * "Blood work" on the Health page, H5 (#189): the way into the biomarker
 * views (`/health/biomarkers`). A link, not data: the Health page does not
 * fetch lab results itself. It names the unit system those views use (#234).
 */
import { useId } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { DEFAULT_LAB_UNITS, labUnitsNote, type LabUnits } from '../../../utils/labUnits';

export const VIEW_BIOMARKERS_LABEL = 'View biomarkers';

export interface BloodWorkSectionProps {
  /** #234: the unit system the biomarker views show values in. */
  labUnits?: LabUnits;
}

export function BloodWorkSection({ labUnits = DEFAULT_LAB_UNITS }: BloodWorkSectionProps = {}) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="h5" component="h2" gutterBottom>
        Blood work
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
        <Typography color="text.secondary" sx={{ flex: '1 1 240px', minWidth: 0 }}>
          Your lab results over time: the latest value of each biomarker, how it changed and the lab's reference range.{' '}
          <span data-testid="lab-units-note">{labUnitsNote(labUnits)}.</span>
        </Typography>
        <Button component={RouterLink} to="/health/biomarkers" variant="outlined" startIcon={<ScienceOutlinedIcon />}>
          {VIEW_BIOMARKERS_LABEL}
        </Button>
      </Box>
    </Box>
  );
}

export default BloodWorkSection;
