/**
 * The photos a workout was prefilled from (E4.5, VISION §87: photos stay
 * linked to the data they helped create). Thumbnails through signed URLs
 * fetched on demand (`StoragePhotoThumb`); a photo deleted from storage
 * shows a "removed" placeholder. Renders nothing when there are none.
 */
import { Card, CardContent, Stack, Typography } from '@mui/material';
import { StoragePhotoThumb } from '../intake/StoragePhotoThumb';
import type { WorkoutPhotoView } from '../../services/workouts';

const THUMB_SIZE = 96;

export interface WorkoutPhotosProps {
  photos: readonly WorkoutPhotoView[];
}

export function WorkoutPhotos({ photos }: WorkoutPhotosProps) {
  if (photos.length === 0) return null;
  return (
    <Card variant="outlined" component="section" aria-labelledby="workout-photos-heading">
      <CardContent>
        <Typography id="workout-photos-heading" variant="subtitle2" component="h2" sx={{ mb: 1 }}>
          Photos
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }} role="list" aria-label="Workout photos">
          {photos.map((photo, index) => (
            <div role="listitem" key={photo.id}>
              <StoragePhotoThumb
                storageObjectId={photo.storageObjectId}
                name={photo.caption ?? `Workout photo ${index + 1}`}
                size={THUMB_SIZE}
              />
            </div>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default WorkoutPhotos;
