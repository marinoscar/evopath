/**
 * Progress photos (`/health/progress-photos`), E7.9 (#249). Owned by the
 * `health` destination through the `/health` prefix; reached from the
 * "Progress photos" section of the Health page and from the Coach's
 * "Take photo" button (`?add=1` opens the add flow directly).
 *
 * - Gallery grouped by month, newest first, "Load more" through `nextCursor`.
 * - Pose filter chips (All, Front, Side, Back, Other) go to the API.
 * - Add photo (needs `health_data:write`, and `storage:write` to upload):
 *   pose, date, note, and the ghost overlay of the last photo of that pose.
 * - Compare: two photos of one pose, side by side or with a slider.
 * - Delete asks for confirmation.
 *
 * PRIVATE TO THE USER: never shared with AI, never in a notification. The
 * route is gated on `health_data:read` in `App.tsx`; the API enforces every
 * permission on every call, this page only hides what cannot work.
 */
import { useCallback, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Chip, Container, Skeleton, Stack, Typography } from '@mui/material';
import {
  AddAPhotoOutlined as AddIcon,
  ArrowBack as ArrowBackIcon,
  CompareOutlined as CompareIcon,
  LockOutlined as LockIcon,
  PhotoLibraryOutlined as GalleryIcon,
} from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useProgressPhotos } from '../hooks/useProgressPhotos';
import { useStorageStatus } from '../hooks/useStorageStatus';
import { EmptyState } from '../components/common/EmptyState';
import { PhotoGallery } from '../components/progress/PhotoGallery';
import { AddProgressPhotoDialog } from '../components/progress/AddProgressPhotoDialog';
import { CompareProgressPhotosDialog } from '../components/progress/CompareProgressPhotosDialog';
import { DeleteProgressPhotoDialog } from '../components/progress/DeleteProgressPhotoDialog';
import { HEALTH_DATA_UNAVAILABLE } from '../services/health';
import {
  PROGRESS_PHOTO_POSES,
  PROGRESS_PHOTO_POSE_LABELS,
  PROGRESS_PHOTOS_PRIVACY_COPY,
  type ProgressPhoto,
  type ProgressPhotoPose,
} from '../services/progressPhotos';

export const PROGRESS_PHOTOS_TITLE = 'Progress photos';
export const ADD_PHOTO_LABEL = 'Add photo';
export const COMPARE_LABEL = 'Compare';
export const LOAD_MORE_LABEL = 'Load more';

function PoseFilter({
  value,
  onChange,
}: {
  value: ProgressPhotoPose | null;
  onChange: (pose: ProgressPhotoPose | null) => void;
}) {
  const options: { pose: ProgressPhotoPose | null; label: string }[] = [
    { pose: null, label: 'All' },
    ...PROGRESS_PHOTO_POSES.map((pose) => ({ pose, label: PROGRESS_PHOTO_POSE_LABELS[pose] })),
  ];
  return (
    <Box role="group" aria-label="Filter by pose" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {options.map(({ pose, label }) => {
        const selected = value === pose;
        return (
          <Chip
            key={label}
            label={label}
            clickable
            color={selected ? 'primary' : 'default'}
            variant={selected ? 'filled' : 'outlined'}
            aria-pressed={selected}
            onClick={() => onChange(pose)}
          />
        );
      })}
    </Box>
  );
}

function ProgressPhotosContent({ canWrite, canUpload }: { canWrite: boolean; canUpload: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [pose, setPose] = useState<ProgressPhotoPose | null>(null);
  const { photos, hasMore, isLoading, isLoadingMore, error, forbidden, loadMore, refresh, removeLocal } =
    useProgressPhotos(pose);
  const { configured } = useStorageStatus({ skip: !canWrite || !canUpload });
  const [addOpen, setAddOpen] = useState(() => canWrite && searchParams.get('add') === '1');
  const [compareOpen, setCompareOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ProgressPhoto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const closeAdd = useCallback(() => {
    setAddOpen(false);
    if (searchParams.has('add')) {
      const next = new URLSearchParams(searchParams);
      next.delete('add');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const onAdded = () => {
    setNotice('Photo added.');
    void refresh();
  };

  const onDeleted = (photo: ProgressPhoto) => {
    removeLocal(photo.id);
    setNotice('Photo deleted.');
  };

  if (forbidden) return <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>;

  return (
    <>
      <Stack spacing={3}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <PoseFilter value={pose} onChange={setPose} />
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <Button variant="outlined" startIcon={<CompareIcon />} onClick={() => setCompareOpen(true)}>
              {COMPARE_LABEL}
            </Button>
            {canWrite && (
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
                {ADD_PHOTO_LABEL}
              </Button>
            )}
          </Box>
        </Box>

        <Box role="status" aria-live="polite" sx={{ minHeight: 0 }}>
          {notice && (
            <Alert severity="success" onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          )}
        </Box>

        {error && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {isLoading && photos.length === 0 ? (
          <Box
            data-testid="progress-photos-loading"
            sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(4, 1fr)' } }}
          >
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} variant="rounded" sx={{ width: '100%', height: 'auto', aspectRatio: '3 / 4' }} />
            ))}
          </Box>
        ) : photos.length === 0 && !error ? (
          <EmptyState
            Icon={GalleryIcon}
            title={pose ? `No ${PROGRESS_PHOTO_POSE_LABELS[pose].toLowerCase()} photos yet` : 'No progress photos yet'}
            description="A photo every couple of weeks, same pose, same light, shows change the scale misses."
            action={
              canWrite ? (
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
                  {ADD_PHOTO_LABEL}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <PhotoGallery photos={photos} canDelete={canWrite} onDelete={setToDelete} />
        )}

        {hasMore && (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <Button variant="outlined" onClick={() => void loadMore()} disabled={isLoadingMore}>
              {isLoadingMore ? 'Loading…' : LOAD_MORE_LABEL}
            </Button>
          </Box>
        )}
      </Stack>

      {canWrite && (
        <AddProgressPhotoDialog
          open={addOpen}
          onClose={closeAdd}
          onAdded={onAdded}
          initialPose={pose ?? 'front'}
          canUpload={canUpload}
          storageConfigured={configured !== false}
        />
      )}
      <CompareProgressPhotosDialog
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        initialPose={pose ?? 'front'}
      />
      <DeleteProgressPhotoDialog photo={toDelete} onClose={() => setToDelete(null)} onDeleted={onDeleted} />
    </>
  );
}

export default function ProgressPhotosPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('health_data:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/health" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
          Health
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          {PROGRESS_PHOTOS_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 3 }}>
          <LockIcon fontSize="small" aria-hidden />
          {PROGRESS_PHOTOS_PRIVACY_COPY}
        </Typography>
        {canRead ? (
          <ProgressPhotosContent
            canWrite={hasPermission('health_data:write')}
            canUpload={hasPermission('storage:write')}
          />
        ) : (
          <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
        )}
      </Box>
    </Container>
  );
}
