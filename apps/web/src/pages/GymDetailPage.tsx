/**
 * One gym (`/gyms/:gymId`), E3.3: the header (name, type, chips, Edit, Set
 * default, Delete), the Equipment section grouped by category with the
 * picker, and the Photos section with upload and the lightbox. A plain stack
 * of sections, no tabs.
 *
 * `gyms:write` enables every mutation; photo upload additionally needs
 * `storage:write` (the viewer role has neither the upload nor the control).
 * Nothing on this page needs AI: "Scan gym" (E3.4) is a secondary way to
 * fill the equipment list, disabled with its reason when the scan cannot
 * run, and the manual "Add equipment" never depends on it.
 *
 * Navigation state it reads (set by the scan page): `openPicker` opens the
 * equipment picker ("Continue manually"), `flash` shows a one-off message
 * ("3 added, 1 already there. Photos saved to this gym.").
 *
 * The Location section (E3.5) sets or clears the optional GPS position through
 * `PUT/DELETE /gyms/:id/location`; the edit dialog leaves it alone.
 */
import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import { Add as AddIcon, ArrowBack as BackIcon, Edit as EditIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useGym } from '../hooks/useGym';
import {
  GYMS_UNAVAILABLE,
  GYM_TYPE_LABEL,
  gymRefusalMessage,
  temporaryGymExpiryText,
  type GymEquipment,
  type GymPhoto,
} from '../services/gyms';
import { GymForm } from '../components/gyms/GymForm';
import { ConfirmDialog } from '../components/gyms/ConfirmDialog';
import { EquipmentList } from '../components/gyms/EquipmentList';
import { EquipmentEditDialog } from '../components/gyms/EquipmentEditDialog';
import { EquipmentPickerDialog } from '../components/gyms/EquipmentPickerDialog';
import { GymPhotos } from '../components/gyms/GymPhotos';
import { useStorageStatus } from '../hooks/useStorageStatus';
import { GymPhotoLightbox } from '../components/gyms/GymPhotoLightbox';
import { useCompactDialog } from '../components/gyms/useCompactDialog';
import { deleteGymMessage } from '../components/gyms/gymCopy';
import { ScanGymButton } from '../components/gyms/ScanGymButton';
import { GymLocationField } from '../components/gyms/GymLocationField';
import { SaveGymDialog } from '../components/gyms/SaveGymPrompt';
import type { GymDetailLocationState } from '../services/gymScan';

const EDIT_FORM_ID = 'gym-edit-form';

type Pending =
  | { kind: 'gym' }
  | { kind: 'equipment'; item: GymEquipment }
  | { kind: 'photo'; photo: GymPhoto }
  | null;

function GymDetail({ gymId, canWrite, canUpload }: { gymId: string; canWrite: boolean; canUpload: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fullScreen = useCompactDialog();
  const g = useGym(gymId);
  // #204: only asked when the upload control would be offered.
  const storage = useStorageStatus({ skip: !(canWrite && canUpload) });
  const incoming = (location.state ?? null) as GymDetailLocationState | null;
  const [editOpen, setEditOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(Boolean(incoming?.openPicker) && canWrite);
  const [flash, setFlash] = useState<string | null>(incoming?.flash ?? null);
  const [editing, setEditing] = useState<GymEquipment | null>(null);
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  // The target outlives `pendingOpen` so the dialog keeps its text while it closes.
  const [pending, setPendingState] = useState<Pending>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const setPending = (next: Pending) => {
    if (next) setPendingState(next);
    setPendingOpen(next !== null);
  };
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { gym } = g;

  // Navigation state is one-shot: drop it so a reload or Back does not replay it.
  useEffect(() => {
    if (incoming?.openPicker || incoming?.flash) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
    // Only on arrival.
  }, []);

  if (g.notFound) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" component={RouterLink} to="/gyms">
            All gyms
          </Button>
        }
      >
        This gym does not exist or was deleted.
      </Alert>
    );
  }

  if (!gym) {
    if (g.error && !g.isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void g.refresh()}>
              Retry
            </Button>
          }
        >
          Could not load this gym. {g.error}
        </Alert>
      );
    }
    return (
      <Stack spacing={2} data-testid="gym-detail-skeleton">
        <Skeleton variant="text" width="40%" height={48} />
        <Skeleton variant="rounded" height={160} />
      </Stack>
    );
  }

  const openPhoto = gym.photos.find((p) => p.id === openPhotoId) ?? null;

  const makeDefault = async () => {
    setDefaultBusy(true);
    setActionError(null);
    try {
      await g.setDefault();
    } catch (err) {
      setActionError(gymRefusalMessage(err, 'Could not set the default gym'));
    } finally {
      setDefaultBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    if (pending.kind === 'gym') {
      await g.remove();
      navigate('/gyms', { replace: true });
      return;
    }
    if (pending.kind === 'equipment') await g.removeEquipment(pending.item.id);
    else {
      await g.removePhoto(pending.photo.id);
      setOpenPhotoId(null);
    }
    setPending(null);
  };

  const pendingCopy =
    pending?.kind === 'gym'
      ? { title: 'Delete gym?', message: deleteGymMessage(gym.name, gym.photos.length), confirm: 'Delete' }
      : pending?.kind === 'equipment'
        ? {
            title: 'Remove equipment?',
            message: `Remove ${pending.item.equipmentType.name} from ${gym.name}?`,
            confirm: 'Remove',
          }
        : { title: 'Remove photo?', message: 'Remove this photo? The file is deleted too.', confirm: 'Remove' };

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, mb: 3 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h4" component="h1" gutterBottom sx={{ overflowWrap: 'anywhere' }}>
            {gym.name}
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mb: 1 }}>
            <Chip size="small" variant="outlined" label={GYM_TYPE_LABEL[gym.type] ?? gym.type} />
            {gym.isDefault && <Chip size="small" color="primary" label="Default" />}
            {gym.isTemporary && <Chip size="small" color="secondary" variant="outlined" label="Temporary" />}
          </Stack>
          {gym.isTemporary && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="gym-detail-expiry">
              {temporaryGymExpiryText(gym.updatedAt)} unless you save it.
            </Typography>
          )}
          {gym.description && (
            <Typography sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{gym.description}</Typography>
          )}
          {gym.notes && (
            <Typography color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
              {gym.notes}
            </Typography>
          )}
        </Box>
        {canWrite && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            {gym.isTemporary && (
              <Button variant="contained" onClick={() => setSaveOpen(true)}>
                Save gym
              </Button>
            )}
            {!gym.isDefault && !gym.isTemporary && (
              <Button onClick={() => void makeDefault()} disabled={defaultBusy}>
                Set default
              </Button>
            )}
            <Button color="error" onClick={() => setPending({ kind: 'gym' })}>
              Delete
            </Button>
          </Stack>
        )}
      </Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      <Stack spacing={4}>
        <Paper component="section" variant="outlined" aria-labelledby="gym-equipment-heading" sx={{ p: { xs: 2, sm: 3 } }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 2 }}>
            <Typography id="gym-equipment-heading" variant="h5" component="h2" sx={{ flexGrow: 1 }}>
              Equipment
            </Typography>
            {canWrite && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' }, width: { xs: '100%', sm: 'auto' } }}>
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => setPickerOpen(true)}>
                  Add equipment
                </Button>
                <ScanGymButton gymId={gym.id} />
              </Stack>
            )}
          </Box>
          {gym.equipment.length === 0 ? (
            <Typography color="text.secondary">
              Nothing listed yet. Add what this gym has, from dumbbells to the cable station.
            </Typography>
          ) : (
            <EquipmentList
              items={gym.equipment}
              canWrite={canWrite}
              onQuantityChange={(item, quantity) => g.updateEquipment(item.id, { quantity })}
              onEdit={setEditing}
              onRemove={(item) => setPending({ kind: 'equipment', item })}
            />
          )}
        </Paper>

        <Paper component="section" variant="outlined" aria-labelledby="gym-photos-heading" sx={{ p: { xs: 2, sm: 3 } }}>
          <Typography id="gym-photos-heading" variant="h5" component="h2" sx={{ mb: 2 }}>
            Photos
          </Typography>
          <GymPhotos
            photos={gym.photos}
            canWrite={canWrite}
            canUpload={canUpload}
            storageConfigured={storage.configured !== false}
            onAdd={g.addPhoto}
            onOpen={(photo) => setOpenPhotoId(photo.id)}
            onRemove={(photo) => setPending({ kind: 'photo', photo })}
          />
        </Paper>

        <Paper component="section" variant="outlined" aria-labelledby="gym-location-heading" sx={{ p: { xs: 2, sm: 3 } }}>
          <Typography id="gym-location-heading" variant="h5" component="h2" sx={{ mb: 2 }}>
            Location
          </Typography>
          <GymLocationField
            latitude={gym.latitude}
            longitude={gym.longitude}
            canWrite={canWrite}
            onSave={g.setLocation}
            onClear={g.clearLocation}
          />
        </Paper>
      </Stack>

      <Dialog
        open={editOpen}
        onClose={editSubmitting ? undefined : () => setEditOpen(false)}
        fullScreen={fullScreen}
        fullWidth
        maxWidth="sm"
        aria-labelledby="gym-edit-title"
      >
        <DialogTitle id="gym-edit-title">Edit gym</DialogTitle>
        <DialogContent dividers>
          {editOpen && (
            <GymForm
              formId={EDIT_FORM_ID}
              hideActions
              submitLabel="Save"
              initial={gym}
              onSubmittingChange={setEditSubmitting}
              onSubmit={async (input) => {
                await g.update(input);
                setEditOpen(false);
              }}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={editSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form={EDIT_FORM_ID} variant="contained" disabled={editSubmitting}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <SaveGymDialog
        open={saveOpen}
        gym={gym.isTemporary ? gym : null}
        onClose={() => setSaveOpen(false)}
        onSave={(input) => g.update({ ...input, isTemporary: false })}
      />

      <EquipmentPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={async (input) => {
          await g.addEquipment(input);
        }}
      />
      <EquipmentEditDialog
        open={editing !== null}
        item={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => (editing ? g.updateEquipment(editing.id, input) : Promise.resolve())}
      />
      <GymPhotoLightbox
        photo={openPhoto}
        equipment={gym.equipment}
        canWrite={canWrite}
        onClose={() => setOpenPhotoId(null)}
        onSave={g.updatePhoto}
        onRemove={(photo) => setPending({ kind: 'photo', photo })}
      />
      <ConfirmDialog
        open={pendingOpen}
        title={pendingCopy.title}
        message={pendingCopy.message}
        confirmLabel={pendingCopy.confirm}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
      />
      <Snackbar
        open={flash !== null}
        autoHideDuration={6000}
        onClose={() => setFlash(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setFlash(null)} sx={{ width: '100%' }}>
          {flash}
        </Alert>
      </Snackbar>
    </>
  );
}

export default function GymDetailPage() {
  const { gymId } = useParams<{ gymId: string }>();
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('gyms:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/gyms" startIcon={<BackIcon />} sx={{ mb: 2 }}>
          All gyms
        </Button>
        {canRead && gymId ? (
          <GymDetail
            gymId={gymId}
            canWrite={hasPermission('gyms:write')}
            canUpload={hasPermission('storage:write')}
          />
        ) : (
          <>
            <Typography variant="h4" component="h1" gutterBottom>
              Gym
            </Typography>
            <Alert severity="info">{GYMS_UNAVAILABLE}</Alert>
          </>
        )}
      </Box>
    </Container>
  );
}
