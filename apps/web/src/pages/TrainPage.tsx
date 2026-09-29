import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import TimelineIcon from '@mui/icons-material/Timeline';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import { Link as RouterLink } from 'react-router-dom';
import { Button } from '@mui/material';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { usePermissions } from '../hooks/usePermissions';
import { PlaceholderPage, type PlaceholderSection } from '../components/common/PlaceholderPage';

const SECTIONS: PlaceholderSection[] = [
  {
    title: "Today's session",
    description: 'The workout planned for today, ready to start in one tap.',
    Icon: PlayCircleOutlinedIcon,
  },
  {
    title: 'Programs',
    description: 'Training programs you follow across weeks.',
    Icon: CalendarMonthIcon,
  },
  {
    title: 'Log and history',
    description: 'Sets, reps and weights, and every past session.',
    Icon: TimelineIcon,
  },
  {
    title: 'Quick workouts',
    description: 'Bodyweight, travel or equipment-limited sessions when the plan does not fit.',
    Icon: FlashOnIcon,
  },
];

export default function TrainPage() {
  const { hasPermission } = usePermissions();
  // E4.1: the exercise library is the first part of Train that works.
  const actions = hasPermission('exercises:read') ? (
    <Button component={RouterLink} to="/train/exercises" variant="outlined" startIcon={<MenuBookIcon />}>
      Exercise library
    </Button>
  ) : undefined;
  return (
    <PlaceholderPage
      title="Train"
      subtitle="Your programs and workouts."
      area="workouts"
      sections={SECTIONS}
      actions={actions}
      note="Every workout can be planned and logged by hand. Photos and AI drafts will be optional helpers."
    />
  );
}
