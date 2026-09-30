/**
 * "Adjust today's workout" (E6.1): what the user can say (minutes, sore,
 * equipment, low energy, gym, free text, today's readiness), which models
 * will run, and what will be sent, then `POST /api/ai/training/adaptations`
 * and on to the adaptation page (`/train/adapt/:id`), which follows the run.
 *
 * A dialog on desktop; full-screen on compact windows (below `sm`), the
 * dialog-presentation idiom of `useCompactDialog`, not one of the five
 * navigation breakpoint gates. Focus moves to the title when it opens.
 *
 * "Different place" in the gym select (E6.2) swaps the form for
 * `HotelGymScanStep`: make a temporary gym, scan or fill it, confirm, and
 * come back with it selected.
 *
 * The API decides: the at-least-one rule is mirrored so the button can say
 * "Tell us what to change" before the round trip, and every refusal is
 * explained with the step that fixes it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useCompactDialog } from '../../gyms/useCompactDialog';
import { useGyms } from '../../../hooks/useGyms';
import { useGym } from '../../../hooks/useGym';
import { useCheckIn } from '../../../hooks/useCheckIn';
import { usePermissions } from '../../../hooks/usePermissions';
import { useTrainingAvailability } from '../../../hooks/useTrainingAvailability';
import { useAdaptationPreview } from '../../../hooks/useAdaptation';
import { useMonthlyAgentUsage } from '../../../hooks/useAgentUsage';
import {
  ADAPTATION_LIMITS,
  ADAPTATION_REFUSALS,
  adaptationRefusalOf,
  adaptationRequestProblem,
  rememberAdaptation,
  startAdaptation,
  type AdaptationRequest,
  type AdaptationRoleModel,
} from '../../../services/trainingAdaptation';
import type { RoleResolution } from '../../../services/trainingAgents';
import { AdaptChips, type EquipmentOption } from './AdaptChips';
import { RoleModelBanner, roleProblem } from './RoleModelBanner';
import { SentDataSummary } from './SentDataSummary';
import { buildRequest, draftFromRequest, type AdaptDraft } from './adaptDraft';
import { HotelGymScanStep, type HotelGymResult } from './HotelGymScanStep';
import type { GymDetail } from '../../../services/gyms';

export const ADAPT_SHEET_TITLE = "Adjust today's workout";
/** The gym select's "Different place" value (never a gym id). */
export const DIFFERENT_PLACE = '__different_place__';
export const DIFFERENT_PLACE_LABEL = 'Different place (scan a new gym)';
export const TEMPORARY_GYM_HINT = 'A temporary gym. After the workout you can save it for future use.';

const tokenCount = new Intl.NumberFormat('en-US');

/**
 * "Typically about 8,400 tokens" (E6.3): the median of the user's own last
 * completed adjustments (`typical.adapt`), never a guess. With too little
 * history the API answers `null` and nothing is said. Whether a run would hit
 * the per-run limit is never predicted; only the real cap message appears.
 */
export function typicalTokensText(medianTokens: number): string {
  return `Typically about ${tokenCount.format(medianTokens)} tokens`;
}

export interface AdaptWorkoutSheetProps {
  open: boolean;
  onClose: () => void;
  /** "Adjust again": start from what was asked last time. */
  initialRequest?: Partial<AdaptationRequest> | null;
  /** Preview debounce; tests pass 0. */
  previewDelayMs?: number;
}

interface SubmitProblem {
  title?: string;
  message: string;
  link?: { label: string; to: string };
}

const RUNNABLE_STATES = ['ready', 'auto', 'stale_preference'];

function fromResolution(role: 'planner' | 'critic', resolution: RoleResolution | undefined): AdaptationRoleModel | null {
  if (!resolution) return null;
  return {
    role,
    state: resolution.state,
    model: resolution.model
      ? { provider: resolution.model.provider, modelId: resolution.model.modelId, displayName: resolution.model.displayName }
      : null,
    effectiveEffort: resolution.effectiveEffort,
    fix: resolution.fix,
    runnable: RUNNABLE_STATES.includes(resolution.state),
  };
}

/** A refused start, in words, with the step that fixes it. */
export function startProblem(err: unknown): SubmitProblem {
  const refusal = adaptationRefusalOf(err);
  if (!refusal) return { message: 'Could not start the adjustment. Try again.' };
  const { reason, details, message } = refusal;
  switch (reason) {
    case ADAPTATION_REFUSALS.IN_PROGRESS: {
      const id = typeof details.adaptationId === 'string' ? details.adaptationId : null;
      return {
        title: 'An adjustment is already running',
        message: 'Wait for it to finish, or open it to cancel it.',
        link: id ? { label: 'Open it', to: `/train/adapt/${encodeURIComponent(id)}` } : undefined,
      };
    }
    case ADAPTATION_REFUSALS.ROLE_UNAVAILABLE: {
      const role = details.role === 'critic' ? 'critic' : 'planner';
      const problem = roleProblem({
        role,
        state: (typeof details.state === 'string' ? details.state : 'no_models') as AdaptationRoleModel['state'],
        model: null,
        effectiveEffort: null,
        fix: details.fix === 'keys' || details.fix === 'settings' || details.fix === 'admin' ? details.fix : null,
        runnable: false,
      });
      return { title: 'An agent cannot run', message: problem?.message ?? message, link: problem?.fix ?? undefined };
    }
    case ADAPTATION_REFUSALS.GYM_EQUIPMENT_UNCONFIRMED:
      return {
        title: 'Confirm the equipment first',
        message: 'This gym has no equipment yet. Choose Different place to scan it or add equipment, or choose Bodyweight only.',
      };
    case ADAPTATION_REFUSALS.EQUIPMENT_NOT_IN_GYM:
      return { message: "Some of the equipment you chose isn't at this gym. Choose again." };
    case ADAPTATION_REFUSALS.AI_DISABLED:
      return { title: 'AI was turned off', message: 'Your administrator switched AI off. You can still start the planned workout yourself.' };
    default:
      return { message: message || 'Could not start the adjustment. Try again.' };
  }
}

export function AdaptWorkoutSheet({ open, onClose, initialRequest, previewDelayMs }: AdaptWorkoutSheetProps) {
  const fullScreen = useCompactDialog();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canReadGyms = hasPermission('gyms:read');
  const { gyms, refresh: refreshGyms } = useGyms({ enabled: open && canReadGyms });
  const { checkIn } = useCheckIn({ enabled: open && hasPermission('health_data:read') });
  const { models } = useTrainingAvailability();
  // Read only while open; a failed read simply shows no hint.
  const typical = useMonthlyAgentUsage(undefined, { enabled: open }).report?.typical.adapt ?? null;
  const [draft, setDraft] = useState<AdaptDraft>(() => draftFromRequest(initialRequest));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SubmitProblem | null>(null);
  const [triedSubmit, setTriedSubmit] = useState(false);
  // E6.2: the "Different place" step, and the temporary gym it made (kept while the sheet is open).
  const [mode, setMode] = useState<'form' | 'hotel'>('form');
  const [hotelGym, setHotelGym] = useState<GymDetail | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // A fresh sheet every time it opens.
  useEffect(() => {
    if (open) {
      setDraft(draftFromRequest(initialRequest));
      setProblem(null);
      setTriedSubmit(false);
      setBusy(false);
      setMode('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const defaultGym = useMemo(() => gyms.find((g) => g.isDefault) ?? null, [gyms]);
  // "Only these" lists the chosen gym's equipment, else the default gym's.
  const equipmentGymId = draft.gymId || defaultGym?.id || undefined;
  const { gym: equipmentGym, isLoading: equipmentLoading } = useGym(
    open && draft.equipment === 'only' && canReadGyms ? equipmentGymId : undefined,
  );
  const equipmentOptions: EquipmentOption[] | null = useMemo(() => {
    if (draft.equipment !== 'only') return null;
    if (!equipmentGymId || !canReadGyms) return [];
    if (!equipmentGym || equipmentLoading) return null;
    const seen = new Map<string, string>();
    for (const row of equipmentGym.equipment) seen.set(row.equipmentType.id, row.equipmentType.name);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [canReadGyms, draft.equipment, equipmentGym, equipmentGymId, equipmentLoading]);

  const request = useMemo(() => buildRequest(draft, equipmentGymId ?? null), [draft, equipmentGymId]);
  const requestProblem = adaptationRequestProblem(request);
  const { preview, isLoading: previewLoading, error: previewError } = useAdaptationPreview(request, {
    enabled: open && mode === 'form',
    delayMs: previewDelayMs,
  });

  const roleModels = preview?.models ?? (() => {
    const planner = fromResolution('planner', models?.roles.planner);
    const critic = fromResolution('critic', models?.roles.critic);
    return planner && critic ? { planner, critic } : null;
  })();
  const roleBlocked = !!roleModels && (!roleModels.planner.runnable || !roleModels.critic.runnable);

  const suggestions = {
    sore:
      checkIn?.soreness !== null && checkIn?.soreness !== undefined && checkIn.soreness >= 4
        ? `Your check-in says you're sore (${checkIn.soreness}/5). Tap I'm sore to adjust for it.`
        : null,
    lowEnergy:
      checkIn?.energy !== null && checkIn?.energy !== undefined && checkIn.energy <= 2
        ? `Your check-in says your energy is low (${checkIn.energy}/5).`
        : null,
  };

  const change = (patch: Partial<AdaptDraft>) => {
    setProblem(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const submit = async () => {
    setTriedSubmit(true);
    if (requestProblem) return;
    setBusy(true);
    setProblem(null);
    try {
      const started = await startAdaptation(request);
      rememberAdaptation(started.adaptationId);
      onClose();
      navigate(`/train/adapt/${encodeURIComponent(started.adaptationId)}`);
    } catch (err) {
      setProblem(startProblem(err));
      setBusy(false);
    }
  };

  const freeTextLength = draft.freeText.length;

  const hotelDone = ({ gym, bodyweight }: HotelGymResult) => {
    if (gym) {
      setHotelGym(gym);
      void refreshGyms();
    }
    change({
      ...(gym ? { gymId: gym.id } : {}),
      equipment: bodyweight ? 'bodyweight' : 'gym',
      equipmentTypeIds: [],
    });
    setMode('form');
  };
  const hotelBack = (gym: GymDetail | null) => {
    if (gym) {
      setHotelGym(gym);
      void refreshGyms();
    }
    setMode('form');
  };

  // The temporary gym just made may not be in the list yet.
  const gymOptions = hotelGym && !gyms.some((g) => g.id === hotelGym.id) ? [...gyms, hotelGym] : gyms;
  const selectedGym = gymOptions.find((g) => g.id === draft.gymId) ?? null;

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="adapt-sheet-title"
      slotProps={{ transition: { onEntered: () => titleRef.current?.focus() } }}
    >
      <DialogTitle id="adapt-sheet-title" ref={titleRef} tabIndex={-1} sx={{ outline: 'none' }}>
        {ADAPT_SHEET_TITLE}
      </DialogTitle>
      <DialogContent dividers>
        {mode === 'hotel' ? (
          <HotelGymScanStep initialGym={hotelGym} onDone={hotelDone} onBack={hotelBack} />
        ) : (
          <Stack spacing={2.5}>
            <Typography variant="body2" color="text.secondary" data-testid="adapt-base">
              {preview
                ? preview.base
                  ? `Adjusting ${preview.base.name}. You decide what to do with the result.`
                  : 'No planned workout today: you get a fresh session. You decide what to do with it.'
                : 'Say what is different today. You decide what to do with the result.'}
            </Typography>
            <RoleModelBanner models={roleModels} />
            <AdaptChips
              draft={draft}
              onChange={change}
              equipmentOptions={equipmentOptions}
              suggestions={suggestions}
              disabled={busy}
            />
            {canReadGyms && (
              <TextField
                select
                label="Gym"
                value={draft.gymId}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value === DIFFERENT_PLACE) {
                    setProblem(null);
                    setMode('hotel');
                    return;
                  }
                  change({ gymId: e.target.value, equipmentTypeIds: [] });
                }}
                fullWidth
                helperText={selectedGym?.isTemporary ? TEMPORARY_GYM_HINT : "Where you'll train today."}
              >
                <MenuItem value="">The plan&apos;s gym, or your default gym</MenuItem>
                {gymOptions.map((gym) => (
                  <MenuItem key={gym.id} value={gym.id}>
                    {gym.name}
                    {gym.isDefault ? ' (default)' : ''}
                    {gym.isTemporary ? ' (temporary)' : ''}
                  </MenuItem>
                ))}
                <MenuItem value={DIFFERENT_PLACE}>{DIFFERENT_PLACE_LABEL}</MenuItem>
              </TextField>
            )}
            <TextField
              label="Anything else? (optional)"
              placeholder="Left shoulder feels tight"
              value={draft.freeText}
              disabled={busy}
              onChange={(e) => change({ freeText: e.target.value.slice(0, ADAPTATION_LIMITS.freeTextChars) })}
              multiline
              minRows={2}
              fullWidth
              helperText={`${freeTextLength}/${ADAPTATION_LIMITS.freeTextChars}`}
              slotProps={{ htmlInput: { maxLength: ADAPTATION_LIMITS.freeTextChars } }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draft.useReadiness}
                  disabled={busy}
                  onChange={(e) => change({ useReadiness: e.target.checked })}
                />
              }
              label="Use today's readiness"
            />
            {preview?.blocked && (
              <Alert severity="warning" data-testid="adapt-blocked">
                <AlertTitle>This needs attention first</AlertTitle>
                {preview.blocked.guidance}
              </Alert>
            )}
            <SentDataSummary sentData={preview?.sentData ?? null} isLoading={previewLoading} error={previewError} />
            {problem && (
              <Alert severity="warning" role="alert" data-testid="adapt-problem">
                {problem.title && <AlertTitle>{problem.title}</AlertTitle>}
                {problem.message}{' '}
                {problem.link && (
                  <Link component={RouterLink} to={problem.link.to} onClick={onClose}>
                    {problem.link.label}
                  </Link>
                )}
              </Alert>
            )}
            {triedSubmit && requestProblem && (
              <Alert severity="info" role="alert" data-testid="adapt-invalid">
                {requestProblem}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      {mode === 'form' && (
        <DialogActions sx={{ px: 3, py: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {typical && (
              <Typography id="adapt-typical-tokens" variant="body2" color="text.secondary" data-testid="adapt-typical-tokens">
                {typicalTokensText(typical.medianTokens)}
              </Typography>
            )}
          </Box>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void submit()}
            disabled={busy || roleBlocked}
            aria-describedby={typical ? 'adapt-typical-tokens' : undefined}
          >
            {busy ? 'Starting…' : 'Adjust workout'}
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
}

export default AdaptWorkoutSheet;
