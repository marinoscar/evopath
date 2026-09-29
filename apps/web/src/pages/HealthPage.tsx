import MonitorWeightIcon from '@mui/icons-material/MonitorWeight';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import MoodIcon from '@mui/icons-material/Mood';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import { PlaceholderPage, type PlaceholderSection } from '../components/common/PlaceholderPage';

const SECTIONS: PlaceholderSection[] = [
  {
    title: 'Body',
    description: 'Weight, body fat and waist over time.',
    Icon: MonitorWeightIcon,
  },
  {
    title: 'Vitals',
    description: 'Blood pressure and resting heart rate.',
    Icon: MonitorHeartIcon,
  },
  {
    title: 'Daily check-in',
    description: 'Energy, sleep, soreness and stress in a few taps.',
    Icon: MoodIcon,
  },
  {
    title: 'Trends',
    description: 'See whether what you are doing is working.',
    Icon: ShowChartIcon,
  },
];

export default function HealthPage() {
  return (
    <PlaceholderPage
      title="Health"
      subtitle="Your body and how you feel, in one place."
      area="health"
      sections={SECTIONS}
      note="Log a value by hand or from a photo of your scale. Nothing is required."
    />
  );
}
