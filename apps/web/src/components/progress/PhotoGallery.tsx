/**
 * The progress-photo gallery (E7.9, #249): photos grouped by month, newest
 * month first, each a tile with its date and pose. A tile's delete button
 * (only with `health_data:write`) asks the page to confirm; nothing is
 * deleted from here.
 *
 * The grid is 2 columns on a phone, 3 from `sm` and 4 from `md`. Every image's
 * accessible name is its date and pose only, never a description of a body.
 */
import { useId } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { DeleteOutlined as DeleteIcon } from '@mui/icons-material';
import {
  PROGRESS_PHOTO_POSE_LABELS,
  formatPhotoDate,
  groupProgressPhotosByMonth,
  progressPhotoAlt,
  type ProgressPhoto,
  type ProgressPhotoMonth,
} from '../../services/progressPhotos';
import { ProgressPhotoImage } from './ProgressPhotoImage';

export interface PhotoGalleryProps {
  photos: readonly ProgressPhoto[];
  canDelete: boolean;
  onDelete: (photo: ProgressPhoto) => void;
}

function MonthSection({
  month,
  canDelete,
  onDelete,
}: {
  month: ProgressPhotoMonth;
  canDelete: boolean;
  onDelete: (photo: ProgressPhoto) => void;
}) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} data-testid="progress-photo-month">
      <Typography id={headingId} variant="h6" component="h2" gutterBottom>
        {month.label}
      </Typography>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          p: 0,
          m: 0,
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
        }}
      >
        {month.photos.map((photo) => {
          const date = formatPhotoDate(photo.localDate);
          const pose = PROGRESS_PHOTO_POSE_LABELS[photo.pose];
          return (
            <Box
              component="li"
              key={photo.id}
              data-testid="progress-photo-tile"
              sx={{ minWidth: 0, borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider' }}
            >
              <ProgressPhotoImage
                storageObjectId={photo.storageObjectId}
                alt={progressPhotoAlt(photo)}
                sx={{ width: '100%', aspectRatio: '3 / 4' }}
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5 }}>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {date}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="p">
                    {pose}
                    {photo.note ? ` · ${photo.note}` : ''}
                  </Typography>
                </Box>
                {canDelete && (
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      aria-label={`Delete ${pose.toLowerCase()} photo from ${date}`}
                      onClick={() => onDelete(photo)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function PhotoGallery({ photos, canDelete, onDelete }: PhotoGalleryProps) {
  const months = groupProgressPhotosByMonth(photos);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {months.map((month) => (
        <MonthSection key={month.key} month={month} canDelete={canDelete} onDelete={onDelete} />
      ))}
    </Box>
  );
}

export default PhotoGallery;
