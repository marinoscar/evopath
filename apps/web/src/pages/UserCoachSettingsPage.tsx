/**
 * Settings → Coach (`/settings/coach`), E7.3 (#243); docs/specs/ai-coach.md
 * §2.3, §2.4, §2.13, §3.1.
 *
 * The user's AI Coach: the persona gallery (static sample lines, no model
 * call), intensity, Sarge's adult-language unlock behind an 18+ dialog,
 * spoken messages, quiet hours, the daily nudge cap, lock-screen-safe
 * notifications, the progress-photo cadence and "your why".
 *
 * A REGISTRY CARD of its own (`USER_SETTINGS_SECTIONS`, AI group,
 * `permission: 'ai:use'`, `feature: 'ai'`); the route wraps it in
 * `RequirePermission('ai:use')` and `RequireAiEnabled`. The `ai:use`
 * re-check below is defence in depth.
 *
 * THE API DECIDES. The page renders `effective` and `policy` from
 * `GET /api/coach/settings`: whether adult language is unlocked and why not
 * (`effective.register.reason`), the cap actually applied, the deployment's
 * switches. A refusal on save is mapped from `details.code` / `details.reason`.
 *
 * Two save paths. The form (persona, intensity, audio, schedule, why) is a
 * draft saved with one PUT carrying only what changed; a network failure keeps
 * the draft on screen with a retry. The adult-language switch saves at once,
 * optimistically, because its "on" goes through the 18+ dialog: confirming
 * sends `PUT` with `confirmAdult: true` (the server stamps the time), and a
 * `COACH_PROFANITY_LOCKED` refusal reverts the switch and names the failed
 * condition.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Container,
  FormControlLabel,
  FormHelperText,
  MenuItem,
  Paper,
  Slider,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { useCoachSettings } from '../hooks/useCoachSettings';
import { useCoachVoices } from '../hooks/useCoachVoices';
import { PersonaGallery } from '../components/coach/PersonaGallery';
import { ProfanityConfirmDialog } from '../components/coach/ProfanityConfirmDialog';
import { QuietHoursField, isValidTimeOfDay } from '../components/coach/QuietHoursField';
import { CoachVoicePreviewButton } from '../components/coach/CoachVoicePreviewButton';
import {
  COACH_AUDIO_SPEED_MAX,
  COACH_AUDIO_SPEED_MIN,
  COACH_ERRORS,
  COACH_INTENSITY_MAX,
  COACH_INTENSITY_MIN,
  COACH_PHOTO_CADENCES,
  COACH_VOICE_PREVIEW_AVAILABLE,
  COACH_WHY_MAX_LENGTH,
  coachSaveErrorMessage,
  profanityReasonText,
  type CoachPersonaCard,
  type CoachSettingsPut,
  type CoachSettingsView,
} from '../services/coach';
import type { CoachPhotoCadence } from '../types';

/** Mirrors the `Coach` card in `config/userSettingsSections.tsx`. */
export const COACH_PAGE_TITLE = 'Coach';

export const AUDIO_POLICY_OFF_MESSAGE =
  'Spoken coach messages are switched off for this deployment by your administrator.';
export const COACH_POLICY_OFF_MESSAGE =
  'Your administrator has switched the coach off for this deployment. You can still choose your settings; the coach sends nothing until it is switched back on.';
export const NO_VOICES_MESSAGE =
  'No voice is available for spoken messages yet. Ask an administrator to assign a speech model to Coach voice.';

const PHOTO_CADENCE_LABELS: Record<CoachPhotoCadence, string> = {
  off: 'Never',
  weekly: 'Every week',
  biweekly: 'Every two weeks',
  monthly: 'Every month',
};

interface Draft {
  enabled: boolean;
  personaId: string;
  intensity: number;
  audioEnabled: boolean;
  /** `''` = the persona's default voice. */
  voice: string;
  speed: number;
  quietStart: string;
  quietEnd: string;
  maxNudgesPerDay: number;
  lockScreenSafe: boolean;
  photoCadence: CoachPhotoCadence;
  why: string;
}

function toDraft(view: CoachSettingsView): Draft {
  const { settings, effective } = view;
  return {
    enabled: settings.enabled,
    personaId: settings.personaId,
    intensity: settings.intensity,
    audioEnabled: settings.audio.enabled,
    voice: settings.audio.voice ?? '',
    speed: settings.audio.speed,
    quietStart: settings.quietHours.start,
    quietEnd: settings.quietHours.end,
    // What the coach will actually use: the stored value clamped to the ceiling.
    maxNudgesPerDay: effective.maxNudgesPerDay,
    lockScreenSafe: settings.lockScreenSafe,
    photoCadence: settings.photoCadence,
    why: settings.why ?? '',
  };
}

/** Only what changed against `base`, in the PUT's shape. */
export function draftPatch(draft: Draft, base: Draft): CoachSettingsPut {
  const patch: CoachSettingsPut = {};
  if (draft.enabled !== base.enabled) patch.enabled = draft.enabled;
  if (draft.personaId !== base.personaId) patch.personaId = draft.personaId;
  if (draft.intensity !== base.intensity) patch.intensity = draft.intensity;
  const audio: NonNullable<CoachSettingsPut['audio']> = {};
  if (draft.audioEnabled !== base.audioEnabled) audio.enabled = draft.audioEnabled;
  if (draft.voice !== base.voice) audio.voice = draft.voice === '' ? null : draft.voice;
  if (draft.speed !== base.speed) audio.speed = draft.speed;
  if (Object.keys(audio).length > 0) patch.audio = audio;
  const quiet: NonNullable<CoachSettingsPut['quietHours']> = {};
  if (draft.quietStart !== base.quietStart) quiet.start = draft.quietStart;
  if (draft.quietEnd !== base.quietEnd) quiet.end = draft.quietEnd;
  if (Object.keys(quiet).length > 0) patch.quietHours = quiet;
  if (draft.maxNudgesPerDay !== base.maxNudgesPerDay) patch.maxNudgesPerDay = draft.maxNudgesPerDay;
  if (draft.lockScreenSafe !== base.lockScreenSafe) patch.lockScreenSafe = draft.lockScreenSafe;
  if (draft.photoCadence !== base.photoCadence) patch.photoCadence = draft.photoCadence;
  if (draft.why !== base.why) patch.why = draft.why.trim() === '' ? null : draft.why;
  return patch;
}

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <Paper component="section" aria-labelledby={id} sx={{ p: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Typography id={id} variant="h6" component="h2">
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>
      )}
      {children}
    </Paper>
  );
}

function profaneLevelOf(persona: CoachPersonaCard | undefined) {
  return persona?.intensities.find((entry) => entry.profane) ?? null;
}

export default function UserCoachSettingsPage() {
  const { hasPermission } = usePermissions();
  const coach = useCoachSettings();
  const voices = useCoachVoices();
  const { view, personas, save } = coach;

  const [draftState, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Adult language: an optimistic value while its PUT is in flight.
  const [profanityOverride, setProfanityOverride] = useState<boolean | null>(null);
  const [profanityError, setProfanityError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profanityBusy, setProfanityBusy] = useState(false);

  const base = useMemo(() => (view ? toDraft(view) : null), [view]);
  // Untouched, the draft IS the loaded view; after the first edit it is the
  // user's own, and only a full save replaces it (a profanity save keeps it).
  const draft = draftState ?? base;

  if (!hasPermission('ai:use')) {
    return <Navigate to="/" replace />;
  }

  const header = (
    <>
      <Typography variant="h4" component="h1" gutterBottom>
        {COACH_PAGE_TITLE}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Choose who coaches you and how hard they push, when they may message you, and whether they speak.
      </Typography>
    </>
  );

  if (coach.isLoading && !view) {
    return (
      <Container maxWidth="lg">
        <Box sx={{ py: { xs: 2, md: 4 } }}>
          {header}
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress aria-label="Loading your coach settings" />
          </Box>
        </Box>
      </Container>
    );
  }

  if (!view || !draft || !base) {
    return (
      <Container maxWidth="lg">
        <Box sx={{ py: { xs: 2, md: 4 } }}>
          {header}
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void coach.refresh()}>
                Retry
              </Button>
            }
          >
            {coach.loadError ?? 'Failed to load your coach settings'}
          </Alert>
        </Box>
      </Container>
    );
  }

  const { policy, effective, settings } = view;
  const selectedPersona = personas.find((persona) => persona.id === draft.personaId);
  const profaneLevel = profaneLevelOf(selectedPersona);
  const intensityLabel = (level: number) =>
    selectedPersona?.intensities.find((entry) => entry.level === level)?.label ?? `Level ${level}`;
  const defaultVoice =
    selectedPersona?.intensities.find((entry) => entry.level === draft.intensity)?.voice ?? effective.voice;

  const ceiling = policy.maxNudgesPerDayCeiling;
  const nudgeOptions = Array.from({ length: Math.max(ceiling, 1) }, (_, index) => index + 1);
  const capClamped = settings.maxNudgesPerDay > ceiling;

  const whyTooLong = draft.why.length > COACH_WHY_MAX_LENGTH;
  const quietInvalid = !isValidTimeOfDay(draft.quietStart) || !isValidTimeOfDay(draft.quietEnd);
  const invalid = whyTooLong || quietInvalid;
  const patch = draftPatch(draft, base);
  const dirty = Object.keys(patch).length > 0;

  const profanityOn = profanityOverride ?? settings.profanity;
  const underage = effective.register.reason === 'underage';
  const atProfaneLevel = !!profaneLevel && draft.intensity === profaneLevel.level;

  const audioControlsDisabled = !policy.allowAudio || !draft.audioEnabled;
  const voiceOptions = [...voices.voices];
  if (draft.voice !== '' && !voiceOptions.includes(draft.voice)) voiceOptions.push(draft.voice);

  const update = (next: Partial<Draft>) => setDraft((prev) => ({ ...(prev ?? base), ...next }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!dirty || invalid) return;
    setSaveError(null);
    const result = await save(patch);
    if (result.ok) {
      setDraft(toDraft(result.view));
      setSaved('Coach settings saved');
    } else {
      // The draft stays on screen; only the refused value is put back.
      if (result.error.code === COACH_ERRORS.AUDIO_DISABLED) update({ audioEnabled: base.audioEnabled });
      if (result.error.code === COACH_ERRORS.DISABLED) update({ enabled: base.enabled });
      setSaveError(coachSaveErrorMessage(result.error));
    }
  };

  const setProfanity = async (on: boolean) => {
    setProfanityError(null);
    setProfanityOverride(on);
    setProfanityBusy(true);
    // Turning it on applies to the persona and level on the page, so both
    // travel with it: the server checks condition 4 against them.
    const body: CoachSettingsPut = on
      ? { personaId: draft.personaId, intensity: draft.intensity, profanity: true, confirmAdult: true }
      : { profanity: false };
    const result = await save(body);
    setProfanityBusy(false);
    setDialogOpen(false);
    setProfanityOverride(null);
    if (result.ok) {
      setSaved(on ? 'Adult language is on' : 'Adult language is off');
    } else {
      setProfanityError(
        result.error.code === COACH_ERRORS.PROFANITY_LOCKED
          ? profanityReasonText(result.error.reason)
          : coachSaveErrorMessage(result.error),
      );
    }
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        {header}

        <Alert severity="info" sx={{ mb: 3 }}>
          Coach messages are written by AI from your training activity. They can be wrong, and they are not medical
          advice.
        </Alert>

        {!policy.enabled && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            {COACH_POLICY_OFF_MESSAGE}
          </Alert>
        )}

        <Box component="form" onSubmit={(event) => void submit(event)} noValidate>
          <Stack spacing={3}>
            <Section id="coach-enabled-title" title="Coach messages">
              <FormControlLabel
                control={
                  <Switch
                    checked={draft.enabled}
                    disabled={!policy.enabled && !draft.enabled}
                    onChange={(event) => update({ enabled: event.target.checked })}
                  />
                }
                label="Let the coach message me"
              />
              <FormHelperText>
                {policy.enabled
                  ? 'Nudges, celebrations and your weekly review. Turn this off to silence the coach completely.'
                  : 'The coach is switched off for this deployment, so it cannot be turned on.'}
              </FormHelperText>
            </Section>

            <Section
              id="coach-persona-title"
              title="Persona"
              description="Pick the voice your coach writes in. Sample lines are fixed examples, so previewing them costs nothing."
            >
              <PersonaGallery
                personas={personas}
                selectedId={draft.personaId}
                activeId={settings.personaId}
                level={draft.intensity}
                register={effective.register}
                onSelect={(personaId) => update({ personaId })}
              />
            </Section>

            <Section
              id="coach-intensity-title"
              title="Intensity"
              description={`How hard ${selectedPersona?.name ?? 'your coach'} pushes.`}
            >
              <Box sx={{ px: { xs: 1.5, sm: 2 }, maxWidth: 480 }}>
                <Slider
                  value={draft.intensity}
                  min={COACH_INTENSITY_MIN}
                  max={COACH_INTENSITY_MAX}
                  step={1}
                  marks={[1, 2, 3].map((level) => ({ value: level, label: intensityLabel(level) }))}
                  getAriaValueText={(value) => `${value}, ${intensityLabel(value)}`}
                  slotProps={{ input: { 'aria-label': 'Intensity' } }}
                  onChange={(_event, value) => update({ intensity: value as number })}
                />
              </Box>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Level {draft.intensity}: {intensityLabel(draft.intensity)}
                {selectedPersona && ` · ${selectedPersona.style}`}
              </Typography>
              {atProfaneLevel && !effective.register.profane && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Until adult language is unlocked, {profaneLevel?.label} sounds like {intensityLabel(draft.intensity - 1)}.
                </Typography>
              )}
            </Section>

            {profaneLevel && (
              <Section
                id="coach-profanity-title"
                title="Adult language"
                description={`${selectedPersona?.name} at ${profaneLevel.label} (level ${profaneLevel.level}) can swear. It is off unless you turn it on, and only for adults.`}
              >
                {!policy.allowProfanePersonas ? (
                  <Alert severity="info" data-testid="profanity-policy-off">
                    {profanityReasonText('system_disabled')}
                  </Alert>
                ) : (
                  <Stack spacing={1}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={profanityOn && !underage}
                          disabled={profanityBusy || underage || (!profanityOn && !atProfaneLevel)}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setProfanityError(null);
                              setDialogOpen(true);
                            } else {
                              void setProfanity(false);
                            }
                          }}
                        />
                      }
                      label="Adult language (18+)"
                    />
                    <FormHelperText data-testid="profanity-status">
                      {underage
                        ? profanityReasonText('underage')
                        : !profanityOn && !atProfaneLevel
                          ? `Choose ${selectedPersona?.name} at ${profaneLevel.label} (level ${profaneLevel.level}) to turn this on.`
                          : effective.register.profane
                            ? 'On. Your coach may swear at this level.'
                            : profanityReasonText(effective.register.reason)}
                    </FormHelperText>
                    {profanityError && (
                      <Alert severity="error" role="alert" onClose={() => setProfanityError(null)}>
                        <AlertTitle>Adult language was not turned on</AlertTitle>
                        {profanityError}
                      </Alert>
                    )}
                  </Stack>
                )}
              </Section>
            )}

            <Section
              id="coach-audio-title"
              title="Spoken messages"
              description="Hear your coach as well as reading it. Every spoken message is also sent as text, and is labelled as AI-generated audio."
            >
              <Stack spacing={2}>
                {!policy.allowAudio && (
                  <Alert severity="info" data-testid="audio-policy-off">
                    {AUDIO_POLICY_OFF_MESSAGE}
                  </Alert>
                )}
                <FormControlLabel
                  control={
                    <Switch
                      checked={draft.audioEnabled}
                      disabled={!policy.allowAudio}
                      onChange={(event) => update({ audioEnabled: event.target.checked })}
                    />
                  }
                  label="Speak my coach messages"
                />
                {policy.allowAudio && (voices.status === 'unavailable' || voices.status === 'error') && (
                  <Alert severity="info">{NO_VOICES_MESSAGE}</Alert>
                )}
                <TextField
                  select
                  size="small"
                  id="coach-voice"
                  label="Voice"
                  value={draft.voice}
                  disabled={audioControlsDisabled}
                  onChange={(event) => update({ voice: event.target.value })}
                  sx={{ maxWidth: 360 }}
                  fullWidth
                >
                  <MenuItem value="">Persona default ({defaultVoice})</MenuItem>
                  {voiceOptions.map((voice) => (
                    <MenuItem key={voice} value={voice}>
                      {voice}
                    </MenuItem>
                  ))}
                </TextField>
                <Box sx={{ px: { xs: 1.5, sm: 2 }, maxWidth: 480 }}>
                  <Typography id="coach-speed-label" variant="body2" gutterBottom>
                    Speed: {draft.speed.toFixed(2)}×
                  </Typography>
                  <Slider
                    value={draft.speed}
                    min={COACH_AUDIO_SPEED_MIN}
                    max={COACH_AUDIO_SPEED_MAX}
                    step={0.05}
                    disabled={audioControlsDisabled}
                    marks={[
                      { value: COACH_AUDIO_SPEED_MIN, label: `${COACH_AUDIO_SPEED_MIN}×` },
                      { value: 1, label: '1×' },
                      { value: COACH_AUDIO_SPEED_MAX, label: `${COACH_AUDIO_SPEED_MAX}×` },
                    ]}
                    getAriaValueText={(value) => `${value.toFixed(2)} times`}
                    slotProps={{ input: { 'aria-labelledby': 'coach-speed-label' } }}
                    onChange={(_event, value) => update({ speed: value as number })}
                  />
                </Box>
                <CoachVoicePreviewButton
                  available={COACH_VOICE_PREVIEW_AVAILABLE}
                  disabled={audioControlsDisabled || voices.status !== 'ready'}
                  disabledReason={
                    !policy.allowAudio
                      ? AUDIO_POLICY_OFF_MESSAGE
                      : !draft.audioEnabled
                        ? 'Turn on spoken messages to preview a voice.'
                        : NO_VOICES_MESSAGE
                  }
                  request={{
                    personaId: draft.personaId,
                    intensity: draft.intensity,
                    voice: draft.voice || undefined,
                    speed: draft.speed,
                    moment: 'streak_at_risk',
                  }}
                />
              </Stack>
            </Section>

            <Section
              id="coach-schedule-title"
              title="When the coach may message you"
              description="Quiet hours use your time zone from your health profile."
            >
              <Stack spacing={3}>
                <QuietHoursField
                  start={draft.quietStart}
                  end={draft.quietEnd}
                  onChange={({ start, end }) => update({ quietStart: start, quietEnd: end })}
                />
                <TextField
                  select
                  size="small"
                  id="coach-max-nudges"
                  label="Nudges per day, at most"
                  value={Math.min(draft.maxNudgesPerDay, ceiling)}
                  onChange={(event) => update({ maxNudgesPerDay: Number(event.target.value) })}
                  helperText={
                    capClamped
                      ? `You chose ${settings.maxNudgesPerDay}, but your administrator allows at most ${ceiling} a day, so ${ceiling} is used.`
                      : `Your administrator allows up to ${ceiling} a day.`
                  }
                  sx={{ maxWidth: 360 }}
                  fullWidth
                >
                  {nudgeOptions.map((count) => (
                    <MenuItem key={count} value={count}>
                      {count}
                    </MenuItem>
                  ))}
                </TextField>
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={draft.lockScreenSafe}
                        onChange={(event) => update({ lockScreenSafe: event.target.checked })}
                      />
                    }
                    label="Lock-screen safe notifications"
                  />
                  <FormHelperText>
                    Notifications show a clean, general line: no swearing, health terms or numbers. The full message
                    is in the app.
                  </FormHelperText>
                </Box>
                <TextField
                  select
                  size="small"
                  id="coach-photo-cadence"
                  label="Progress photo reminders"
                  value={draft.photoCadence}
                  onChange={(event) => update({ photoCadence: event.target.value as CoachPhotoCadence })}
                  sx={{ maxWidth: 360 }}
                  fullWidth
                >
                  {COACH_PHOTO_CADENCES.map((cadence) => (
                    <MenuItem key={cadence} value={cadence}>
                      {PHOTO_CADENCE_LABELS[cadence]}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </Section>

            <Section
              id="coach-why-title"
              title="Your why"
              description="Why you train, in your own words. Your coach may remind you of it; it is sent to the AI model that writes your messages."
            >
              <TextField
                id="coach-why"
                label="Your why"
                multiline
                minRows={2}
                fullWidth
                value={draft.why}
                error={whyTooLong}
                onChange={(event) => update({ why: event.target.value })}
                helperText={
                  whyTooLong
                    ? `Keep it to ${COACH_WHY_MAX_LENGTH} characters (${draft.why.length} now).`
                    : `${draft.why.length} / ${COACH_WHY_MAX_LENGTH}`
                }
              />
            </Section>

            {saveError && (
              <Alert
                severity="error"
                role="alert"
                onClose={() => setSaveError(null)}
                action={
                  <Button color="inherit" size="small" onClick={() => void submit()} disabled={coach.isSaving || invalid}>
                    Retry
                  </Button>
                }
              >
                <AlertTitle>Could not save</AlertTitle>
                {saveError}
              </Alert>
            )}

            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                alignItems: { xs: 'stretch', sm: 'center' },
                gap: 2,
              }}
            >
              <Button type="submit" variant="contained" disabled={!dirty || invalid || coach.isSaving}>
                {coach.isSaving && !profanityBusy ? 'Saving…' : 'Save changes'}
              </Button>
              {invalid && (
                <Typography variant="body2" color="error">
                  Fix the highlighted fields to save.
                </Typography>
              )}
            </Box>
          </Stack>
        </Box>

        <ProfanityConfirmDialog
          open={dialogOpen}
          busy={profanityBusy}
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => void setProfanity(true)}
        />

        <Snackbar open={!!saved} autoHideDuration={3000} onClose={() => setSaved(null)} message={saved ?? ''} />
      </Box>
    </Container>
  );
}
