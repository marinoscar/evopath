import { Chip } from '@mui/material';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { comingInLabel, type RoadmapArea } from '../../config/roadmap';

interface ComingInChipProps {
  area: RoadmapArea;
}

export function ComingInChip({ area }: ComingInChipProps) {
  return (
    <Chip size="small" variant="outlined" icon={<ScheduleIcon />} label={comingInLabel(area)} />
  );
}

export default ComingInChip;
