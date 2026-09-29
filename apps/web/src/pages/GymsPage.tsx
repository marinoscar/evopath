import PlaceIcon from '@mui/icons-material/Place';
import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import NearMeIcon from '@mui/icons-material/NearMe';
import { PlaceholderPage, type PlaceholderSection } from '../components/common/PlaceholderPage';

const SECTIONS: PlaceholderSection[] = [
  {
    title: 'My gyms',
    description: 'Home, club, office or hotel gyms you use.',
    Icon: PlaceIcon,
  },
  {
    title: 'Equipment',
    description: 'What each gym has and what it can do.',
    Icon: FitnessCenterIcon,
  },
  {
    title: 'Photos',
    description: 'Photograph the equipment and review what is recognised.',
    Icon: PhotoCameraIcon,
  },
  {
    title: 'Nearby',
    description: 'Optional: suggest a gym when you arrive.',
    Icon: NearMeIcon,
  },
];

export default function GymsPage() {
  return (
    <PlaceholderPage
      title="Gyms"
      subtitle="Where you train and what is available there."
      area="gyms"
      sections={SECTIONS}
      note="Add gyms and equipment by hand any time. Photo recognition and location are optional."
    />
  );
}
