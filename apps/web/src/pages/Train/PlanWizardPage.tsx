/**
 * Create a plan with AI (`/train/plans/new`), E5.6. Four steps: goal;
 * schedule and gym; limits and preferences; review and start. Each step
 * validates before Next; the answers survive a reload of the tab
 * (`sessionStorage`, never required).
 *
 * Review shows the agents that will run (model, effort, whose key), what
 * each is sent (the estimate's `sentData`, built by the API's own context
 * builder), the token estimate and cap, and the autonomy choice. **Start**
 * posts `{ kind: 'create', intake }`: the browser sends only the intake,
 * never a prompt.
 *
 * Routed behind `ai:use` and AI being on; the API enforces both again.
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  InputLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon, Close as CloseIcon } from '@mui/icons-material';
import { useGyms } from '../../hooks/useGyms';
import { useExercises } from '../../hooks/useExercises';
import { useIsMounted } from '../../hooks/useIsMounted';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../services/api';
import {
  TRAINING_EXPERIENCE_LEVELS,
  TRAINING_GOAL_TYPES,
  TRAINING_INTAKE_LIMITS as L,
  TRAINING_LIMITATION_AREAS,
  TRAINING_REFUSALS,
  estimateTrainingRun,
  getTrainingModels,
  startTrainingRun,
  trainingRefusalOf,
  type TrainingModelsView,
  type TrainingRunEstimate,
} from '../../services/trainingAgents';
import { toAiErrorInfo } from '../../services/aiErrors';
import { AiErrorAlert } from '../../components/ai/AiErrorAlert';
import { AGENT_SETTINGS_PATH, blockerFor, type TrainingBlocker } from '../../hooks/useTrainingAvailability';
import { RoleSummary } from '../../components/training/RoleSummary';
import { SentDataPanel } from '../../components/training/SentDataPanel';
import { StickyActionBar } from '../../components/training/StickyActionBar';
import { WeekdayPicker } from '../../components/training/WeekdayPicker';
import { EXPERIENCE_LABEL, GOAL_LABEL, LIMITATION_LABEL } from '../../components/training/planLabels';
import {
  MINUTE_PRESETS,
  NO_GYM,
  WIZARD_STEPS,
  clearWizardDraft,
  errorsFromIssues,
  firstErrorStep,
  freeTextOf,
  initialWizardForm,
  loadWizardDraft,
  saveWizardDraft,
  toIntake,
  validateAll,
  validateStep,
  type WizardErrors,
  type WizardForm,
} from '../../components/training/planWizard';
import type { TrainingAgentRole } from '../../types';

export const SAFETY_NOTE =
  'This is used to make the plan conservative. It is not medical advice. If something hurts, stop and see a qualified professional.';

const CREATE_ROLES: TrainingAgentRole[] = ['researcher', 'planner', 'critic'];

const fmt = (n: number) => n.toLocaleString('en-US');

type StartProblem =
  | { kind: 'active'; runId: string | null }
  | { kind: 'role'; blocker: TrainingBlocker }
  | { kind: 'safety'; guidance: string }
  | { kind: 'ai'; error: ReturnType<typeof toAiErrorInfo> }
  | { kind: 'other'; message: string };

export default function PlanWizardPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { hasPermission } = usePermissions();
  const draft = useMemo(() => loadWizardDraft(), []);
  const [step, setStep] = useState(draft?.step ?? 0);
  const [form, setForm] = useState<WizardForm>(draft?.form ?? initialWizardForm());
  const [errors, setErrors] = useState<WizardErrors>({});
  const { gyms, isLoading: gymsLoading, refresh: refreshGyms } = useGyms({ enabled: hasPermission('gyms:read') });

  useEffect(() => saveWizardDraft(step, form), [step, form]);

  // Default the gym once the list is known: the default gym, else the first.
  useEffect(() => {
    if (gymsLoading || form.gymId) return;
    const preferred = gyms.find((g) => g.isDefault) ?? gyms[0];
    setForm((f) => ({ ...f, gymId: preferred ? preferred.id : NO_GYM }));
  }, [gyms, gymsLoading, form.gymId]);

  const update = <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const gymIds = gymsLoading ? null : gyms.map((g) => g.id);

  const next = () => {
    const found = validateStep(step, form, gymIds);
    setErrors(found);
    if (Object.keys(found).length === 0) {
      setStep((s) => Math.min(3, s + 1));
      window.scrollTo?.({ top: 0 });
    }
  };
  const back = () => {
    setErrors({});
    setStep((s) => Math.max(0, s - 1));
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/train/plans" startIcon={<BackIcon />} size="small" sx={{ mb: 1 }}>
          Plans
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Create a plan with AI
        </Typography>
        <Stepper activeStep={step} alternativeLabel sx={{ mb: 3, '& .MuiStepLabel-label': { fontSize: { xs: 11, sm: 14 } } }}>
          {WIZARD_STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
        <Typography variant="h5" component="h2" sx={{ mb: 2 }}>
          {WIZARD_STEPS[step]}
        </Typography>

        {step === 0 && <GoalStep form={form} errors={errors} update={update} />}
        {step === 1 && (
          <ScheduleStep form={form} errors={errors} update={update} gyms={gyms} gymsLoading={gymsLoading} />
        )}
        {step === 2 && <LimitsStep form={form} errors={errors} update={update} setForm={setForm} />}
        {step === 3 && (
          <ReviewStep
            form={form}
            update={update}
            errors={errors}
            setErrors={setErrors}
            goToStep={setStep}
            refreshGyms={refreshGyms}
            gymIds={gymIds}
            onStarted={(runId) => {
              clearWizardDraft();
              if (isMounted()) navigate(`/train/plans/runs/${encodeURIComponent(runId)}`);
            }}
            onBack={back}
          />
        )}

        {step < 3 && (
          <StickyActionBar label="Wizard actions">
            {step > 0 && (
              <Button onClick={back} sx={{ minHeight: 44 }}>
                Back
              </Button>
            )}
            <Button variant="contained" onClick={next} sx={{ minHeight: 44 }}>
              Next
            </Button>
          </StickyActionBar>
        )}
      </Box>
    </Container>
  );
}

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

interface StepProps {
  form: WizardForm;
  errors: WizardErrors;
  update: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
}

function GoalStep({ form, errors, update }: StepProps) {
  return (
    <Stack spacing={3}>
      <FormControl>
        <FormLabel id="goal-type-label">Goal</FormLabel>
        <RadioGroup
          aria-labelledby="goal-type-label"
          value={form.goalType}
          onChange={(e) => update('goalType', e.target.value as WizardForm['goalType'])}
        >
          {TRAINING_GOAL_TYPES.map((goal) => (
            <FormControlLabel key={goal} value={goal} control={<Radio />} label={GOAL_LABEL[goal]} />
          ))}
        </RadioGroup>
      </FormControl>
      <TextField
        label="In your words"
        placeholder="For example: build muscle for my upper body without hurting my knee"
        value={form.goalDescription}
        onChange={(e) => update('goalDescription', e.target.value)}
        multiline
        minRows={2}
        error={!!errors['goal.description']}
        helperText={errors['goal.description'] ?? `${form.goalDescription.length}/${L.goalChars}`}
        slotProps={{ htmlInput: { maxLength: L.goalChars + 50 } }}
      />
      <FormControl error={!!errors.experience}>
        <FormLabel id="experience-label">Experience</FormLabel>
        <RadioGroup
          aria-labelledby="experience-label"
          value={form.experience}
          onChange={(e) => update('experience', e.target.value as WizardForm['experience'])}
        >
          {TRAINING_EXPERIENCE_LEVELS.map((level) => (
            <FormControlLabel
              key={level}
              value={level}
              control={<Radio />}
              label={
                <Box>
                  <Typography>{EXPERIENCE_LABEL[level].label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {EXPERIENCE_LABEL[level].description}
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', py: 0.5, '& .MuiRadio-root': { pt: 0.5 } }}
            />
          ))}
        </RadioGroup>
        {errors.experience && <FormHelperText>{errors.experience}</FormHelperText>}
      </FormControl>
    </Stack>
  );
}

function ScheduleStep({
  form,
  errors,
  update,
  gyms,
  gymsLoading,
}: StepProps & { gyms: Array<{ id: string; name: string }>; gymsLoading: boolean }) {
  const preset = (MINUTE_PRESETS as readonly number[]).includes(form.minutesPerSession);
  const [custom, setCustom] = useState(!preset);
  return (
    <Stack spacing={3}>
      <FormControl error={!!errors.daysPerWeek}>
        <FormLabel id="days-label">Days per week</FormLabel>
        <ToggleButtonGroup
          exclusive
          aria-labelledby="days-label"
          value={form.daysPerWeek}
          onChange={(_, value: number | null) => value && update('daysPerWeek', value)}
          sx={{ flexWrap: 'wrap' }}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <ToggleButton key={n} value={n} sx={{ minWidth: 44, minHeight: 44 }}>
              {n}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {errors.daysPerWeek && <FormHelperText>{errors.daysPerWeek}</FormHelperText>}
      </FormControl>

      <FormControl error={!!errors.preferredWeekdays}>
        <FormLabel component="legend">Preferred weekdays (optional)</FormLabel>
        <WeekdayPicker
          label="Preferred weekdays"
          value={form.preferredWeekdays}
          onChange={(days) => update('preferredWeekdays', days)}
        />
        <FormHelperText>{errors.preferredWeekdays ?? `Choose none, or at least ${form.daysPerWeek}.`}</FormHelperText>
      </FormControl>

      <FormControl error={!!errors.minutesPerSession}>
        <FormLabel id="minutes-label">Minutes per session</FormLabel>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-labelledby="minutes-label">
          {MINUTE_PRESETS.map((m) => (
            <Chip
              key={m}
              label={`${m} min`}
              component="button"
              type="button"
              clickable
              color={!custom && form.minutesPerSession === m ? 'primary' : 'default'}
              variant={!custom && form.minutesPerSession === m ? 'filled' : 'outlined'}
              aria-pressed={!custom && form.minutesPerSession === m}
              onClick={() => {
                setCustom(false);
                update('minutesPerSession', m);
              }}
              sx={{ minHeight: 36 }}
            />
          ))}
          <Chip
            label="Custom"
            component="button"
            type="button"
            clickable
            color={custom ? 'primary' : 'default'}
            variant={custom ? 'filled' : 'outlined'}
            aria-pressed={custom}
            onClick={() => setCustom(true)}
            sx={{ minHeight: 36 }}
          />
          {custom && (
            <TextField
              label="Minutes"
              type="number"
              size="small"
              value={Number.isFinite(form.minutesPerSession) ? form.minutesPerSession : ''}
              onChange={(e) => update('minutesPerSession', Math.round(Number(e.target.value)))}
              slotProps={{ htmlInput: { min: L.minutesPerSession.min, max: L.minutesPerSession.max } }}
              sx={{ width: 120 }}
            />
          )}
        </Stack>
        {errors.minutesPerSession && <FormHelperText>{errors.minutesPerSession}</FormHelperText>}
      </FormControl>

      <TextField
        label="Plan length (weeks)"
        type="number"
        value={Number.isFinite(form.durationWeeks) ? form.durationWeeks : ''}
        onChange={(e) => update('durationWeeks', Math.round(Number(e.target.value)))}
        error={!!errors.durationWeeks}
        helperText={errors.durationWeeks ?? `${L.durationWeeks.min} to ${L.durationWeeks.max} weeks`}
        slotProps={{ htmlInput: { min: L.durationWeeks.min, max: L.durationWeeks.max } }}
        sx={{ maxWidth: 240 }}
      />

      <FormControl error={!!errors.gymId} sx={{ maxWidth: 400 }}>
        <InputLabel id="gym-label">Gym</InputLabel>
        {gymsLoading ? (
          <Skeleton variant="rounded" height={56} />
        ) : (
          <Select
            labelId="gym-label"
            label="Gym"
            value={form.gymId}
            onChange={(e) => update('gymId', e.target.value)}
          >
            {gyms.map((gym) => (
              <MenuItem key={gym.id} value={gym.id}>
                {gym.name}
              </MenuItem>
            ))}
            <MenuItem value={NO_GYM}>No equipment</MenuItem>
          </Select>
        )}
        <FormHelperText>
          {errors.gymId ?? (
            <>
              The plan uses only what this gym has.{' '}
              <Link component={RouterLink} to="/gyms">
                Add a gym
              </Link>
            </>
          )}
        </FormHelperText>
      </FormControl>
    </Stack>
  );
}

function LimitsStep({
  form,
  errors,
  update,
  setForm,
}: StepProps & { setForm: Dispatch<SetStateAction<WizardForm>> }) {
  const [query, setQuery] = useState('');
  const { exercises, isLoading } = useExercises({ q: query, enabled: true });
  const areas = form.limitations.map((l) => l.area);

  const toggleArea = (area: (typeof TRAINING_LIMITATION_AREAS)[number]) => {
    setForm((f) =>
      f.limitations.some((l) => l.area === area)
        ? { ...f, limitations: f.limitations.filter((l) => l.area !== area) }
        : f.limitations.length >= L.maxLimitations
          ? f
          : { ...f, limitations: [...f.limitations, { area, description: '' }] },
    );
  };

  return (
    <Stack spacing={3}>
      <Alert severity="info">{SAFETY_NOTE}</Alert>
      <FormControl error={!!errors.limitations}>
        <FormLabel component="legend">Limitations</FormLabel>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }} role="group" aria-label="Limitation areas">
          {TRAINING_LIMITATION_AREAS.map((area) => {
            const selected = areas.includes(area);
            return (
              <Chip
                key={area}
                label={LIMITATION_LABEL[area]}
                component="button"
                type="button"
                clickable
                color={selected ? 'primary' : 'default'}
                variant={selected ? 'filled' : 'outlined'}
                aria-pressed={selected}
                disabled={!selected && form.limitations.length >= L.maxLimitations}
                onClick={() => toggleArea(area)}
                sx={{ minHeight: 36 }}
              />
            );
          })}
        </Stack>
        <FormHelperText>{errors.limitations ?? `At most ${L.maxLimitations}.`}</FormHelperText>
      </FormControl>
      {form.limitations.map((limitation, index) => (
        <TextField
          key={limitation.area}
          label={`${LIMITATION_LABEL[limitation.area]}: what to know`}
          placeholder="For example: mild discomfort on deep squats"
          value={limitation.description}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              limitations: f.limitations.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)),
            }))
          }
          error={!!errors[`limitations.${index}.description`]}
          helperText={errors[`limitations.${index}.description`] ?? `${limitation.description.length}/${L.limitationChars}`}
        />
      ))}

      <Autocomplete
        multiple
        options={exercises}
        loading={isLoading}
        filterOptions={(x) => x}
        getOptionLabel={(option) => option.name}
        isOptionEqualToValue={(a, b) => a.slug === b.slug}
        value={exercises.filter((e) => form.avoid.some((a) => a.slug === e.slug))}
        inputValue={query}
        onInputChange={(_, value) => setQuery(value)}
        onChange={(_, selected) => {
          // Keep avoided exercises that are not in the current search results.
          const kept = form.avoid.filter((a) => !exercises.some((e) => e.slug === a.slug));
          const next = [...kept, ...selected.map((e) => ({ slug: e.slug, name: e.name }))];
          update('avoid', next.slice(0, L.maxAvoidKeys));
        }}
        renderValue={() => null}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Exercises to avoid"
            placeholder="Search the library"
            error={!!errors.avoidExerciseKeys}
            helperText={errors.avoidExerciseKeys ?? `${form.avoid.length}/${L.maxAvoidKeys}`}
          />
        )}
      />
      {form.avoid.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }} aria-label="Avoided exercises" component="ul" style={{ padding: 0, margin: 0 }}>
          {form.avoid.map((a) => (
            <Box component="li" key={a.slug} sx={{ listStyle: 'none' }}>
              <Chip
                label={a.name}
                onDelete={() => update('avoid', form.avoid.filter((x) => x.slug !== a.slug))}
                deleteIcon={<CloseIcon aria-label={`Stop avoiding ${a.name}`} />}
              />
            </Box>
          ))}
        </Stack>
      )}

      <TextField
        label="Preferences (optional)"
        placeholder="For example: I enjoy kettlebells and dislike running"
        value={form.preferences}
        onChange={(e) => update('preferences', e.target.value)}
        multiline
        minRows={2}
        error={!!errors.preferences}
        helperText={errors.preferences ?? `${form.preferences.length}/${L.preferencesChars}`}
      />
    </Stack>
  );
}

// -----------------------------------------------------------------------------
// Review and start
// -----------------------------------------------------------------------------

interface ReviewStepProps {
  form: WizardForm;
  errors: WizardErrors;
  update: StepProps['update'];
  setErrors: (errors: WizardErrors) => void;
  goToStep: (step: number) => void;
  refreshGyms: () => Promise<void>;
  gymIds: string[] | null;
  onStarted: (runId: string) => void;
  onBack: () => void;
}

function ReviewStep({ form, update, setErrors, goToStep, refreshGyms, gymIds, onStarted, onBack }: ReviewStepProps) {
  const isMounted = useIsMounted();
  const { hasPermission } = usePermissions();
  const [models, setModels] = useState<TrainingModelsView | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<TrainingRunEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<StartProblem | null>(null);
  const [blockedText, setBlockedText] = useState<string | null>(null);

  // Re-check the gym on Review: it may have been removed since step 2.
  useEffect(() => {
    void refreshGyms();
  }, [refreshGyms]);

  useEffect(() => {
    getTrainingModels()
      .then((view) => isMounted() && setModels(view))
      .catch((err) => isMounted() && setModelsError(err instanceof Error ? err.message : 'Could not load the agents'));
  }, [isMounted]);

  const intakeKey = JSON.stringify(toIntake(form));
  const loadEstimate = useCallback(async () => {
    setEstimateError(null);
    try {
      const result = await estimateTrainingRun({ kind: 'create', intake: JSON.parse(intakeKey) });
      if (isMounted()) setEstimate(result);
    } catch (err) {
      if (!isMounted()) return;
      if (err instanceof ApiError && err.status === 400) {
        const fieldErrors = errorsFromIssues(err.details);
        if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      }
      setEstimateError(err instanceof Error && err.message ? err.message : 'Could not estimate the run');
    }
  }, [intakeKey, isMounted, setErrors]);

  useEffect(() => {
    void loadEstimate();
  }, [loadEstimate]);

  const localErrors = validateAll(form, gymIds);
  const localErrorStep = firstErrorStep(localErrors);
  const blocked = models ? !models.canRun.create : true;
  const sameBlockedText = blockedText !== null && blockedText === freeTextOf(form);
  const researcherProvider = models?.roles.researcher.model?.provider ?? 'the search provider';

  const start = async () => {
    const found = validateAll(form, gymIds);
    const at = firstErrorStep(found);
    if (at !== null) {
      setErrors(found);
      goToStep(at);
      return;
    }
    setStarting(true);
    setProblem(null);
    try {
      const started = await startTrainingRun({ kind: 'create', intake: toIntake(form) });
      if (started.status === 'blocked_safety') {
        setBlockedText(freeTextOf(form));
        setProblem({
          kind: 'safety',
          guidance:
            started.guidance ??
            'What you described may need attention from a medical professional before training. Please get it checked first.',
        });
        return;
      }
      onStarted(started.runId);
    } catch (err) {
      const refusal = trainingRefusalOf(err);
      if (refusal?.reason === TRAINING_REFUSALS.RUN_ACTIVE) {
        setProblem({ kind: 'active', runId: typeof refusal.details.runId === 'string' ? refusal.details.runId : null });
      } else if (refusal?.reason === TRAINING_REFUSALS.ROLE_UNAVAILABLE) {
        const role = (refusal.details.role as TrainingAgentRole) ?? 'researcher';
        setProblem({
          kind: 'role',
          blocker: blockerFor(role, (refusal.details.state as Parameters<typeof blockerFor>[1]) ?? 'no_models', {
            fix: models?.roles[role]?.fix,
            canAssign: hasPermission('ai_config:write'),
          }),
        });
      } else if (err instanceof ApiError && err.status === 400) {
        const fieldErrors = errorsFromIssues(err.details);
        const step = firstErrorStep(fieldErrors);
        setErrors(fieldErrors);
        if (step !== null && step < 3) goToStep(step);
        else setProblem({ kind: 'other', message: err.message || 'Some answers are not valid.' });
      } else if (err instanceof ApiError && (err.status === 403 || refusal?.reason?.startsWith('AI_'))) {
        setProblem({ kind: 'ai', error: toAiErrorInfo(err) });
      } else {
        setProblem({ kind: 'other', message: err instanceof Error && err.message ? err.message : 'Could not start the run' });
      }
    } finally {
      if (isMounted()) setStarting(false);
    }
  };

  return (
    <Stack spacing={3}>
      {localErrorStep !== null && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => goToStep(localErrorStep)}>
              Fix
            </Button>
          }
        >
          {Object.values(localErrors)[0]}
        </Alert>
      )}

      <Box component="section" aria-labelledby="agents-heading">
        <Typography id="agents-heading" variant="h6" component="h3">
          Agents
        </Typography>
        {modelsError ? (
          <Alert severity="error">{modelsError}</Alert>
        ) : models ? (
          <RoleSummary models={models} roles={CREATE_ROLES} />
        ) : (
          <Skeleton variant="rounded" height={120} />
        )}
      </Box>

      <Box component="section" aria-labelledby="sent-heading">
        <Typography id="sent-heading" variant="h6" component="h3" gutterBottom>
          What will be sent
        </Typography>
        {estimate ? (
          <SentDataPanel entries={estimate.sentData} />
        ) : estimateError ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void loadEstimate()}>
                Retry
              </Button>
            }
          >
            {estimateError}
          </Alert>
        ) : (
          <Skeleton variant="rounded" height={120} />
        )}
        <Stack spacing={1} sx={{ mt: 2 }}>
          <FormControlLabel
            control={<Switch checked={form.includeBio} onChange={(e) => update('includeBio', e.target.checked)} />}
            label="Include my bio (the planner reads the short bio from your profile)"
          />
          <FormControlLabel
            control={<Switch checked={form.tailorResearch} onChange={(e) => update('tailorResearch', e.target.checked)} />}
            label="Tailor research to my age and sex (the researcher sees an age band and sex at birth)"
          />
          <Typography variant="body2" color="text.secondary">
            The research agent forms its own web searches from this brief, so your goal and limitations may appear in
            search queries sent to {researcherProvider}.
          </Typography>
        </Stack>
      </Box>

      <Box component="section" aria-labelledby="cost-heading">
        <Typography id="cost-heading" variant="h6" component="h3" gutterBottom>
          Cost
        </Typography>
        {estimate ? (
          <Typography data-testid="token-estimate">
            Estimated {fmt(estimate.tokens.low)} to {fmt(estimate.tokens.high)} tokens, capped at {fmt(estimate.cap)}.{' '}
            <Link component={RouterLink} to={AGENT_SETTINGS_PATH}>
              Change the cap
            </Link>
          </Typography>
        ) : (
          <Skeleton width={280} />
        )}
      </Box>

      <FormControl component="section">
        <FormLabel id="autonomy-label">
          <Typography variant="h6" component="h3" color="text.primary">
            When the coach adjusts your plan
          </Typography>
        </FormLabel>
        <RadioGroup
          aria-labelledby="autonomy-label"
          value={form.autonomy}
          onChange={(e) => update('autonomy', e.target.value as WizardForm['autonomy'])}
        >
          <FormControlLabel value="autonomous" control={<Radio />} label="Adjust my plan automatically (recommended)" />
          <FormControlLabel value="ask_first" control={<Radio />} label="Ask me before changing my plan" />
        </RadioGroup>
        <FormHelperText>You can undo any automatic change with one tap.</FormHelperText>
      </FormControl>

      {problem?.kind === 'safety' && (
        <Alert severity="warning" data-testid="safety-guidance">
          <AlertTitle>Please check this first</AlertTitle>
          {problem.guidance}
          <Box sx={{ mt: 1 }}>
            <Button color="inherit" size="small" onClick={() => goToStep(2)}>
              Edit limitations
            </Button>
          </Box>
        </Alert>
      )}
      {problem?.kind === 'active' && (
        <Alert
          severity="info"
          action={
            problem.runId ? (
              <Button color="inherit" size="small" onClick={() => onStarted(problem.runId!)}>
                Open it
              </Button>
            ) : undefined
          }
        >
          A plan is already being made. Open it to follow along.
        </Alert>
      )}
      {problem?.kind === 'role' && (
        <Alert severity="warning">
          {problem.blocker.message}{' '}
          {problem.blocker.fix && (
            <Link component={RouterLink} to={problem.blocker.fix.to}>
              {problem.blocker.fix.label}
            </Link>
          )}
        </Alert>
      )}
      {problem?.kind === 'ai' && <AiErrorAlert error={problem.error} />}
      {problem?.kind === 'other' && <Alert severity="error">{problem.message}</Alert>}

      <StickyActionBar label="Wizard actions">
        <Button onClick={onBack} sx={{ minHeight: 44 }}>
          Back
        </Button>
        <Button
          variant="contained"
          onClick={() => void start()}
          disabled={starting || blocked || localErrorStep !== null || sameBlockedText}
          startIcon={starting ? <CircularProgress size={16} color="inherit" /> : undefined}
          sx={{ minHeight: 44 }}
          data-testid="wizard-start"
        >
          Start
        </Button>
      </StickyActionBar>
    </Stack>
  );
}

