/**
 * "Different place" in the adjust-workout sheet (E6.2): scan a new gym, a
 * hotel room or anywhere else, then adapt the workout to it.
 *
 * 1. **Setup.** A name ("Hotel gym Sep 30", editable) and the ways in:
 *    **Take photos** when AI can read photos (E3's `useVisionAvailability`,
 *    the vision role is E3's), else E3's `NoVisionModelNotice`; **Pick
 *    equipment manually** and **Bodyweight only** always. A caller without
 *    the scan permissions (`scanPermissionReason`, e.g. no `storage:write`)
 *    is told why and keeps the manual ways; no AI request is made for them.
 * 2. **Scan.** The temporary gym is created (`POST /api/gyms { name,
 *    type: 'hotel', isTemporary: true }`), then E3's own scan steps run on it
 *    (`GymScanFlow`: `ImageIntake` capped at {@link HOTEL_SCAN_MAX_PHOTOS}
 *    photos, the `ai.equipment.scan` job, `AiDraftReview`, Apply). No second
 *    vision job and no new prompt.
 * 3. **Confirm.** What the gym now holds. **Continue** stays disabled until
 *    it has at least one piece of equipment; **Bodyweight only** is the
 *    other way out.
 *
 * The sheet then adapts with `gymId` = the temporary gym. The planning
 * request carries equipment names and capabilities only; never photos,
 * storage ids or the gym name (the API builds it). After the workout the
 * finish summary asks "Save {name} for future use?".
 */
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Chip, Link, Stack, TextField, Typography } from '@mui/material';
import { usePermissions } from '../../../hooks/usePermissions';
import { useVisionAvailability, type UseVisionAvailabilityReturn } from '../../../hooks/useVisionAvailability';
import { useHotelGym } from '../../../hooks/useHotelGym';
import { NoVisionModelNotice } from '../../intake';
import { GymScanFlow } from '../../gyms/GymScanFlow';
import { EquipmentPickerDialog } from '../../gyms/EquipmentPickerDialog';
import { scanPermissionReason } from '../../gyms/scanAvailability';
import {
  GYM_NAME_MAX,
  GYM_REFUSALS,
  gymRefusalMessage,
  gymRefusalReason,
  hotelGymDefaultName,
  type GymDetail,
} from '../../../services/gyms';
import { applySummary } from '../../../services/gymScan';

/** Photos this flow takes (cost control); E3's scan page takes more. */
export const HOTEL_SCAN_MAX_PHOTOS = 6;
export const HOTEL_PHOTOS_HELPER = `Up to ${HOTEL_SCAN_MAX_PHOTOS} photos: the whole room first, then close-ups of racks and labels.`;
export const HOTEL_STEP_TITLE = 'Scan a new gym';
export const CONTINUE_HINT = 'Add at least one piece of equipment, or choose Bodyweight only.';

export function hotelPrivacyNote(provider: string): string {
  return `These photos are sent to ${provider} to identify equipment. Nothing else is sent. Avoid capturing people.`;
}

export interface HotelGymResult {
  /** The temporary gym, or `null` for bodyweight only before any gym was made. */
  gym: GymDetail | null;
  bodyweight: boolean;
}

export interface HotelGymScanStepProps {
  /** A temporary gym this sheet already made: resume at Confirm. */
  initialGym?: GymDetail | null;
  onDone: (result: HotelGymResult) => void;
  /** Back to the sheet; hands back the gym made so far, if any. */
  onBack: (gym: GymDetail | null) => void;
}

type Phase = 'setup' | 'scan' | 'confirm';

interface Problem {
  message: string;
  gymLimit: boolean;
}

function HotelFlow({
  initialGym,
  onDone,
  onBack,
  availability,
  scanReason,
}: HotelGymScanStepProps & { availability: UseVisionAvailabilityReturn | null; scanReason: string | null }) {
  const { hasPermission } = usePermissions();
  const canWriteGyms = hasPermission('gyms:write');
  const hotel = useHotelGym(initialGym ?? null);
  const gym = hotel.gym;
  const [name, setName] = useState(() => initialGym?.name ?? hotelGymDefaultName());
  const [phase, setPhase] = useState<Phase>(initialGym ? 'confirm' : 'setup');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstPhase = useRef(true);

  // Each step change moves focus to the step's heading, so a screen reader hears where it is.
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [phase]);

  const visionReady = scanReason === null && availability?.status === 'ready';

  const create = async (): Promise<boolean> => {
    if (gym) return true;
    setBusy(true);
    setProblem(null);
    try {
      await hotel.ensure(name.trim() || hotelGymDefaultName());
      return true;
    } catch (err) {
      setProblem({
        message: gymRefusalMessage(err, 'Could not create the gym'),
        gymLimit: gymRefusalReason(err) === GYM_REFUSALS.GYM_LIMIT,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startScan = async () => {
    if (await create()) setPhase('scan');
  };
  const pickManually = async () => {
    if (await create()) {
      setPhase('confirm');
      setPickerOpen(true);
    }
  };
  const bodyweightOnly = () => onDone({ gym, bodyweight: true });

  const title = phase === 'confirm' ? 'Confirm the equipment' : HOTEL_STEP_TITLE;
  const equipment = gym?.equipment ?? [];

  let body;
  if (phase === 'scan' && gym && availability && visionReady) {
    body = (
      <Stack spacing={2}>
        <GymScanFlow
          gymId={gym.id}
          availability={availability}
          maxPhotos={HOTEL_SCAN_MAX_PHOTOS}
          photosHelper={HOTEL_PHOTOS_HELPER}
          privacyNote={hotelPrivacyNote(availability.model?.provider ?? 'your AI provider')}
          headingComponent="h4"
          onApplied={(result) => {
            setFlash(applySummary(result));
            void hotel
              .refresh()
              .catch(() => undefined)
              .finally(() => setPhase('confirm'));
          }}
          onDiscarded={() => setPhase('setup')}
          onManual={() => {
            setPhase('confirm');
            setPickerOpen(true);
          }}
        />
        <Box>
          <Button onClick={() => setPhase('confirm')}>Skip the scan</Button>
        </Box>
      </Stack>
    );
  } else if (phase === 'confirm' && gym) {
    const counts = new Map<string, number>();
    for (const row of equipment) counts.set(row.equipmentType.name, (counts.get(row.equipmentType.name) ?? 0) + row.quantity);
    body = (
      <Stack spacing={2} data-testid="hotel-confirm">
        {flash && (
          <Alert severity="success" role="status" onClose={() => setFlash(null)}>
            {flash}
          </Alert>
        )}
        {equipment.length === 0 ? (
          <Typography color="text.secondary" data-testid="hotel-no-equipment" sx={{ overflowWrap: 'anywhere' }}>
            No equipment at {gym.name} yet. Add what is there, or choose Bodyweight only.
          </Typography>
        ) : (
          <>
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {counts.size} {counts.size === 1 ? 'kind' : 'kinds'} of equipment at {gym.name}:
            </Typography>
            <Box component="ul" aria-label="Equipment" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, m: 0, p: 0, listStyle: 'none' }}>
              {[...counts].map(([label, quantity]) => (
                <Box component="li" key={label}>
                  <Chip label={quantity > 1 ? `${label} × ${quantity}` : label} variant="outlined" />
                </Box>
              ))}
            </Box>
          </>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            onClick={() => onDone({ gym, bodyweight: false })}
            disabled={equipment.length === 0}
            aria-describedby={equipment.length === 0 ? 'hotel-continue-hint' : undefined}
          >
            Continue
          </Button>
          {canWriteGyms && (
            <Button variant="outlined" onClick={() => setPickerOpen(true)}>
              Add equipment
            </Button>
          )}
          {visionReady && <Button onClick={() => setPhase('scan')}>Scan photos</Button>}
          <Button onClick={bodyweightOnly}>Bodyweight only</Button>
        </Stack>
        {equipment.length === 0 && (
          <Typography id="hotel-continue-hint" variant="body2" color="text.secondary">
            {CONTINUE_HINT}
          </Typography>
        )}
      </Stack>
    );
  } else {
    body = (
      <Stack spacing={2} data-testid="hotel-setup">
        <Typography variant="body2" color="text.secondary">
          Photograph the room and AI lists the equipment; you confirm it before anything is planned. Or pick the
          equipment yourself. The gym is temporary: you can save it after the workout.
        </Typography>
        {canWriteGyms && (
          <TextField
            label="Name"
            value={name}
            disabled={busy || gym !== null}
            onChange={(e) => setName(e.target.value.slice(0, GYM_NAME_MAX))}
            slotProps={{ htmlInput: { maxLength: GYM_NAME_MAX } }}
            fullWidth
          />
        )}
        {scanReason ? (
          <Alert severity="info" data-testid="hotel-scan-unavailable">
            {scanReason}{' '}
            {canWriteGyms
              ? 'You can still pick the equipment yourself, or train with bodyweight only.'
              : 'You can still train with bodyweight only.'}
          </Alert>
        ) : (
          availability &&
          availability.status !== 'ready' && (
            <NoVisionModelNotice
              reason={availability.status}
              fix={availability.fix}
              onRetry={() => void availability.refresh()}
              onManual={() => void pickManually()}
              disabled={busy}
            />
          )
        )}
        {problem && (
          <Alert severity="warning" role="alert" data-testid="hotel-problem">
            {problem.message}{' '}
            {problem.gymLimit && (
              <Link component={RouterLink} to="/gyms">
                Open gyms
              </Link>
            )}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {visionReady && (
            <Button variant="contained" onClick={() => void startScan()} disabled={busy}>
              Take photos
            </Button>
          )}
          {canWriteGyms && (visionReady || scanReason !== null) && (
            <Button variant={visionReady ? 'outlined' : 'contained'} onClick={() => void pickManually()} disabled={busy}>
              Pick equipment manually
            </Button>
          )}
          <Button onClick={bodyweightOnly} disabled={busy}>
            Bodyweight only
          </Button>
        </Stack>
      </Stack>
    );
  }

  return (
    <Box component="section" aria-labelledby="hotel-step-title" data-testid="hotel-gym-step">
      <Typography
        id="hotel-step-title"
        ref={headingRef}
        tabIndex={-1}
        variant="h6"
        component="h3"
        sx={{ outline: 'none', mb: 1.5, overflowWrap: 'anywhere' }}
      >
        {title}
      </Typography>
      {body}
      <Box sx={{ mt: 2 }}>
        <Button onClick={() => onBack(gym)} disabled={busy}>
          Back
        </Button>
      </Box>
      {canWriteGyms && gym && (
        <EquipmentPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onAdd={(input) => hotel.addEquipment(input)}
        />
      )}
    </Box>
  );
}

function HotelFlowWithVision(props: HotelGymScanStepProps) {
  const availability = useVisionAvailability('gym_scan');
  return <HotelFlow {...props} availability={availability} scanReason={null} />;
}

export function HotelGymScanStep(props: HotelGymScanStepProps) {
  const { hasPermission } = usePermissions();
  const scanReason = scanPermissionReason(hasPermission);
  // Without every scan permission there is no AI request at all.
  if (scanReason) return <HotelFlow {...props} availability={null} scanReason={scanReason} />;
  return <HotelFlowWithVision {...props} />;
}

export default HotelGymScanStep;
