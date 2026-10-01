/**
 * "Progress photos" on the Health page, E7.9 (#249): the way into the private
 * progress-photo gallery (`/health/progress-photos`). A link, not data: the
 * Health page does not fetch photos itself.
 */
import { useId } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined';
import { PROGRESS_PHOTOS_PATH, PROGRESS_PHOTOS_PRIVACY_COPY } from '../../services/progressPhotos';

export const VIEW_PROGRESS_PHOTOS_LABEL = 'View progress photos';

export function ProgressPhotosSection() {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="h5" component="h2" gutterBottom>
        Progress photos
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
        <Typography color="text.secondary" sx={{ flex: '1 1 240px', minWidth: 0 }}>
          Photos of the same pose over time, side by side or with a slider. {PROGRESS_PHOTOS_PRIVACY_COPY}
        </Typography>
        <Button component={RouterLink} to={PROGRESS_PHOTOS_PATH} variant="outlined" startIcon={<PhotoLibraryOutlinedIcon />}>
          {VIEW_PROGRESS_PHOTOS_LABEL}
        </Button>
      </Box>
    </Box>
  );
}

export default ProgressPhotosSection;
