/**
 * The quick-entry dialog for body and vital measurements, issue #53 (E2.3).
 *
 * One short form for all six metrics: weight is focused first, everything
 * else is optional, and only filled fields become readings of ONE entry
 * (`POST /api/measurements`). Logging a weight is: open, type, Enter.
 *
 * Units are the user's (`unitSystem` from the health profile) and every unit,
 * factor and bound comes from the API's catalog (`useMeasurementCatalog`);
 * the dialog sends `{ value, unit }` in the unit shown and the API converts.
 * The checks here explain a problem before the round trip; the API decides.
 *
 * Nothing typed here goes to the URL, the console or analytics.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Link,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link as RouterLink } from 'react-router-dom';
import { ApiError } from '../../services/api';
import {
  createMeasurementEntry,
  HEALTH_DATA_UNAVAILABLE,
  isHealthDataForbidden,
  UNSPECIFIED_METHOD,
  validationIssues,
  type CreateMeasurementEntryInput,
  type HealthProfile,
  type LatestItem,
  type MeasurementDto,
  type MetricDef,
  type MetricKey,
  type UnitSystem,
} from '../../services/health';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { usePermissions } from '../../hooks/usePermissions';
import {
  boundsInDisplayUnits,
  displayUnit,
  formatMeasurement,
  fromDisplay,
  parseDecimal,
  percentDifference,
  withUnit,
} from '../../utils/measurementUnits';
import {
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../../utils/measurementDates';

/** A reading more than this far (percent) from the metric's latest one asks "Check the unit". */
export const SOFT_WARNING_PERCENT = 25;
export const NOTES_MAX_LENGTH = 500;

const FIELDS: ReadonlyArray<{ key: MetricKey; label: string }> = [
  { key: 'weight', label: 'Weight' },
  { key: 'body_fat_pct', label: 'Body fat' },
  { key: 'waist_circumference', label: 'Waist' },
  { key: 'bp_systolic', label: 'Systolic' },
  { key: 'bp_diastolic', label: 'Diastolic' },
  { key: 'resting_hr', label: 'Resting heart rate' },
];

const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label])) as Record<MetricKey, string>;

/** One Method select per group; the blood-pressure pair shares one. */
const METHOD_GROUPS: ReadonlyArray<{ id: string; label: string; keys: MetricKey[] }> = [
  { id: 'weight', label: 'Weight', keys: ['weight'] },
  { id: 'body_fat_pct', label: 'Body fat', keys: ['body_fat_pct'] },
  { id: 'waist_circumference', label: 'Waist', keys: ['waist_circumference'] },
  { id: 'blood_pressure', label: 'Blood pressure', keys: ['bp_systolic', 'bp_diastolic'] },
  { id: 'resting_hr', label: 'Resting heart rate', keys: ['resting_hr'] },
];

const GROUP_OF = Object.fromEntries(
  METHOD_GROUPS.flatMap((group) => group.keys.map((key) => [key, group.id])),
) as Record<MetricKey, string>;

type Values = Record<MetricKey, string>;
type ErrorKey = MetricKey | 'measuredAt' | 'notes' | 'form';
type Errors = Partial<Record<ErrorKey, string>>;

const EMPTY_VALUES: Values = {
  weight: '',
  body_fat_pct: '',
  waist_circumference: '',
  bp_systolic: '',
  bp_diastolic: '',
  resting_hr: '',
};

type SubmitFailure =
  | { kind: 'forbidden' }
  | { kind: 'rejected'; message: string }
  | { kind: 'network' };

export interface LogMeasurementDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the saved readings (canonical) after a successful save, before the dialog closes. */
  onSaved: (items: MeasurementDto[]) => void;
  /** The field to focus instead of Weight (a tile's own Log button). */
  focusMetric?: MetricKey;
  /** `GET /api/measurements/latest`: default methods and the soft warning. */
  latest?: LatestItem[];
  /** The health profile: the unit system. `null`/no row → metric, with a hint. */
  profile?: HealthProfile | null;
}

function isFilled(text: string): boolean {
  return text.trim() !== '';
}

export function LogMeasurementDialog({
  open,
  onClose,
  onSaved,
  focusMetric,
  latest = [],
  profile = null,
}: LogMeasurementDialogProps) {
  const theme = useTheme();
  // A local layout choice for this dialog, NOT one of the five coupled `sm`
  // shell gates (docs/specs/settings-ui.md#breakpoint-gates).
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('health_data:write');
  const { catalog, isLoading: catalogLoading, error: catalogError } = useMeasurementCatalog({
    enabled: open && canWrite,
  });

  const unitSystem: UnitSystem = profile?.unitSystem ?? 'metric';
  const profileMissing = !profile || profile.version === 0;

  const [values, setValues] = useState<Values>(EMPTY_VALUES);
  const [errors, setErrors] = useState<Errors>({});
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [measuredAtText, setMeasuredAtText] = useState('');
  const [measuredAtTouched, setMeasuredAtTouched] = useState(false);
  const [maxDateTime, setMaxDateTime] = useState('');
  const [notes, setNotes] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const savingRef = useRef(false);
  const lastPayload = useRef<CreateMeasurementEntryInput | null>(null);
  const idBase = useId();

  const metricsByKey = useMemo(() => {
    const map = new Map<string, MetricDef>();
    for (const metric of catalog?.metrics ?? []) map.set(metric.key, metric);
    return map;
  }, [catalog]);

  const methodLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const method of catalog?.methods ?? []) map.set(method.key, method.label);
    return map;
  }, [catalog]);

  const latestByKey = useMemo(() => {
    const map = new Map<string, LatestItem>();
    for (const item of latest) map.set(item.metricKey, item);
    return map;
  }, [latest]);

  // A fresh form every time the dialog opens: values, errors, the clock.
  useEffect(() => {
    if (!open) return;
    const now = toDateTimeLocalValue(new Date());
    setValues(EMPTY_VALUES);
    setErrors({});
    setMeasuredAtText(now);
    setMaxDateTime(now);
    setMeasuredAtTouched(false);
    setNotes('');
    setDetailsOpen(false);
    setWarnings(null);
    setFailure(null);
    lastPayload.current = null;
    const defaults: Record<string, string> = {};
    for (const group of METHOD_GROUPS) {
      defaults[group.id] = latestByKey.get(group.keys[0])?.latest?.method ?? UNSPECIFIED_METHOD;
    }
    setMethods(defaults);
    // `latestByKey` is read once per opening on purpose: a refetch while the
    // form is open must not overwrite a method the user picked.
  }, [open]);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const fieldProblem = useCallback(
    (key: MetricKey, text: string): string | null => {
      if (!isFilled(text)) return null;
      const metric = metricsByKey.get(key);
      const value = parseDecimal(text);
      if (value === null) return 'Enter a number';
      if (!metric) return null;
      const { min, max } = boundsInDisplayUnits(metric, unitSystem);
      if (value < min || value > max) {
        return `Enter a value between ${min} and ${withUnit(String(max), displayUnit(metric, unitSystem))}`;
      }
      return null;
    },
    [metricsByKey, unitSystem],
  );

  const validate = useCallback((): Errors => {
    const next: Errors = {};
    for (const { key } of FIELDS) {
      const problem = fieldProblem(key, values[key]);
      if (problem) next[key] = problem;
    }

    const hasSystolic = isFilled(values.bp_systolic);
    const hasDiastolic = isFilled(values.bp_diastolic);
    if (hasSystolic && !hasDiastolic) next.bp_diastolic = 'Enter both numbers';
    if (!hasSystolic && hasDiastolic) next.bp_systolic = 'Enter both numbers';
    if (hasSystolic && hasDiastolic && !next.bp_systolic && !next.bp_diastolic) {
      const systolic = parseDecimal(values.bp_systolic)!;
      const diastolic = parseDecimal(values.bp_diastolic)!;
      if (systolic <= diastolic) next.bp_systolic = 'Systolic must be higher than diastolic';
    }

    if (!FIELDS.some(({ key }) => isFilled(values[key]))) {
      next.form = 'Enter at least one value';
    }

    if (measuredAtTouched) {
      const picked = parseDateTimeLocalValue(measuredAtText);
      if (!picked) next.measuredAt = 'Enter a date and time';
      else if (picked.getTime() > Date.now()) next.measuredAt = 'The time cannot be in the future';
    }

    if (notes.trim().length > NOTES_MAX_LENGTH) {
      next.notes = `Notes must be at most ${NOTES_MAX_LENGTH} characters`;
    }
    return next;
  }, [fieldProblem, values, measuredAtTouched, measuredAtText, notes]);

  const hasErrors = Object.values(errors).some(Boolean);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const buildPayload = (): CreateMeasurementEntryInput => {
    const readings = FIELDS.filter(({ key }) => isFilled(values[key])).map(({ key }) => {
      const metric = metricsByKey.get(key)!;
      const method = methods[GROUP_OF[key]];
      return {
        metricKey: key,
        value: parseDecimal(values[key])!,
        unit: displayUnit(metric, unitSystem),
        ...(method && method !== UNSPECIFIED_METHOD ? { method } : {}),
      };
    });
    const payload: CreateMeasurementEntryInput = { readings };
    if (measuredAtTouched) {
      payload.measuredAt = parseDateTimeLocalValue(measuredAtText)!.toISOString();
    }
    const trimmed = notes.trim();
    if (trimmed) payload.notes = trimmed;
    return payload;
  };

  const softWarnings = (payload: CreateMeasurementEntryInput): string[] => {
    const lines: string[] = [];
    for (const reading of payload.readings) {
      const metric = metricsByKey.get(reading.metricKey);
      const previous = latestByKey.get(reading.metricKey)?.latest;
      if (!metric || !previous) continue;
      const entered = fromDisplay(metric, reading.value, unitSystem);
      const pct = percentDifference(entered, previous.value);
      if (pct > SOFT_WARNING_PERCENT) {
        lines.push(
          `This is ${Math.round(pct)}% different from your last entry (${formatMeasurement(
            metric,
            previous.value,
            unitSystem,
          )}). Check the unit.`,
        );
        if (payload.readings.length > 1) {
          lines[lines.length - 1] = `${FIELD_LABEL[reading.metricKey as MetricKey]}: ${lines[lines.length - 1]}`;
        }
      }
    }
    return lines;
  };

  const applyServerIssues = (err: unknown, payload: CreateMeasurementEntryInput): boolean => {
    const issues = validationIssues(err);
    if (issues.length === 0) return false;
    const next: Errors = {};
    let openDetails = false;
    for (const issue of issues) {
      const [head, index, field] = issue.path.split('.');
      if (head === 'readings' && index !== undefined) {
        const key = payload.readings[Number(index)]?.metricKey as MetricKey | undefined;
        if (key && field === 'method') {
          openDetails = true;
          next.form = next.form ?? issue.message;
        } else if (key) {
          next[key] = next[key] ?? issue.message;
        } else {
          next.form = next.form ?? issue.message;
        }
      } else if (head === 'readings') {
        next.bp_systolic = next.bp_systolic ?? issue.message;
      } else if (head === 'measuredAt' || head === 'notes') {
        next[head] = next[head] ?? issue.message;
        openDetails = true;
      } else {
        next.form = next.form ?? issue.message;
      }
    }
    setErrors(next);
    if (openDetails) setDetailsOpen(true);
    return true;
  };

  const send = async (payload: CreateMeasurementEntryInput) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    setWarnings(null);
    lastPayload.current = payload;
    try {
      const entry = await createMeasurementEntry(payload);
      onSaved(entry.items);
      setSavedOpen(true);
      onClose();
    } catch (err) {
      if (isHealthDataForbidden(err)) {
        setFailure({ kind: 'forbidden' });
      } else if (applyServerIssues(err, payload)) {
        // Field messages are shown under their fields.
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setFailure({ kind: 'rejected', message: err.message });
      } else {
        setFailure({ kind: 'network' });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submit = (confirmed: boolean) => {
    if (savingRef.current || !catalog) return;
    const found = validate();
    setErrors(found);
    if (found.measuredAt || found.notes) setDetailsOpen(true);
    if (Object.values(found).some(Boolean)) return;

    const payload = buildPayload();
    if (!confirmed) {
      const lines = softWarnings(payload);
      if (lines.length > 0) {
        setWarnings(lines);
        return;
      }
    }
    void send(payload);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (warnings) return; // The warning asks for an explicit choice.
    submit(false);
  };

  // ---------------------------------------------------------------------------
  // Field events
  // ---------------------------------------------------------------------------

  const onValueChange = (key: MetricKey, text: string) => {
    setValues((prev) => ({ ...prev, [key]: text }));
    setWarnings(null);
    setErrors((prev) => {
      const next = { ...prev, [key]: undefined, form: undefined };
      if (key === 'bp_systolic' || key === 'bp_diastolic') {
        next.bp_systolic = undefined;
        next.bp_diastolic = undefined;
      }
      return next;
    });
  };

  const onValueBlur = (key: MetricKey) => {
    const problem = fieldProblem(key, values[key]);
    if (problem) setErrors((prev) => ({ ...prev, [key]: problem }));
  };

  const autoFocusKey: MetricKey =
    focusMetric === 'bp_diastolic' ? 'bp_systolic' : (focusMetric ?? 'weight');

  const renderField = (key: MetricKey) => {
    const metric = metricsByKey.get(key);
    const unit = metric ? displayUnit(metric, unitSystem) : '';
    const id = `${idBase}-${key}`;
    return (
      <TextField
        key={key}
        id={id}
        label={FIELD_LABEL[key]}
        value={values[key]}
        onChange={(event) => onValueChange(key, event.target.value)}
        onBlur={() => onValueBlur(key)}
        error={!!errors[key]}
        helperText={errors[key]}
        disabled={saving}
        autoFocus={autoFocusKey === key}
        fullWidth
        autoComplete="off"
        slotProps={{
          input: unit ? { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> } : undefined,
          htmlInput: { inputMode: 'decimal', enterKeyHint: 'done', 'data-testid': `measurement-${key}` },
        }}
      />
    );
  };

  const filledGroups = METHOD_GROUPS.filter((group) => group.keys.some((key) => isFilled(values[key])));

  const dialogOpen = open && canWrite;

  return (
    <>
      <Dialog
        open={dialogOpen}
        onClose={saving ? undefined : onClose}
        fullScreen={fullScreen}
        fullWidth
        maxWidth="sm"
        aria-labelledby={`${idBase}-title`}
      >
        <Box
          component="form"
          noValidate
          onSubmit={onSubmit}
          sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
        >
          <DialogTitle id={`${idBase}-title`}>Log measurement</DialogTitle>
          <DialogContent dividers>
            {catalogLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress aria-label="Loading" />
              </Box>
            )}

            {catalogError && !catalogLoading && (
              <Alert severity="error">
                Could not load the list of measurements. Close this dialog and try again later.
              </Alert>
            )}

            {catalog && (
              <Stack spacing={2}>
                {profileMissing && (
                  <Typography variant="body2" color="text.secondary">
                    Using metric units.{' '}
                    <Link component={RouterLink} to="/settings/health-profile">
                      Change in Health Profile
                    </Link>
                  </Typography>
                )}

                {renderField('weight')}
                {renderField('body_fat_pct')}
                {renderField('waist_circumference')}

                <Box role="group" aria-labelledby={`${idBase}-bp`}>
                  <Typography id={`${idBase}-bp`} variant="subtitle2" component="p" sx={{ mb: 1 }}>
                    Blood pressure
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 2 }}>
                    {renderField('bp_systolic')}
                    {renderField('bp_diastolic')}
                  </Box>
                </Box>

                {renderField('resting_hr')}

                {errors.form && <Alert severity="error">{errors.form}</Alert>}

                <Accordion
                  expanded={detailsOpen}
                  onChange={(_, expanded) => setDetailsOpen(expanded)}
                  disableGutters
                  variant="outlined"
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography>Details</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={2}>
                      {filledGroups.length === 0 && (
                        <Typography variant="body2" color="text.secondary">
                          Enter a value to choose how it was measured.
                        </Typography>
                      )}
                      {filledGroups.map((group) => {
                        const metric = metricsByKey.get(group.keys[0]);
                        return (
                          <TextField
                            key={group.id}
                            id={`${idBase}-method-${group.id}`}
                            select
                            label={`${group.label} method`}
                            value={methods[group.id] ?? UNSPECIFIED_METHOD}
                            onChange={(event) =>
                              setMethods((prev) => ({ ...prev, [group.id]: event.target.value }))
                            }
                            disabled={saving}
                            fullWidth
                          >
                            {(metric?.methods ?? [UNSPECIFIED_METHOD]).map((method) => (
                              <MenuItem key={method} value={method}>
                                {methodLabels.get(method) ?? method}
                              </MenuItem>
                            ))}
                          </TextField>
                        );
                      })}
                      <TextField
                        id={`${idBase}-measured-at`}
                        type="datetime-local"
                        label="Date and time"
                        value={measuredAtText}
                        onChange={(event) => {
                          setMeasuredAtText(event.target.value);
                          setMeasuredAtTouched(true);
                          setErrors((prev) => ({ ...prev, measuredAt: undefined }));
                        }}
                        error={!!errors.measuredAt}
                        helperText={errors.measuredAt}
                        disabled={saving}
                        fullWidth
                        slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: maxDateTime } }}
                      />
                      <TextField
                        id={`${idBase}-notes`}
                        label="Note"
                        value={notes}
                        onChange={(event) => {
                          setNotes(event.target.value);
                          setErrors((prev) => ({ ...prev, notes: undefined }));
                        }}
                        error={!!errors.notes}
                        helperText={errors.notes ?? `${notes.length}/${NOTES_MAX_LENGTH}`}
                        disabled={saving}
                        multiline
                        minRows={2}
                        fullWidth
                        slotProps={{ htmlInput: { maxLength: NOTES_MAX_LENGTH } }}
                      />
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              </Stack>
            )}
          </DialogContent>

          {(warnings || failure) && (
            <Box sx={{ px: 3, pt: 2 }}>
              {warnings && (
                <Alert
                  severity="warning"
                  action={
                    <Stack direction="row" spacing={1} sx={{ alignSelf: 'center' }}>
                      <Button color="inherit" size="small" onClick={() => setWarnings(null)}>
                        Keep editing
                      </Button>
                      <Button color="inherit" size="small" onClick={() => submit(true)}>
                        Save anyway
                      </Button>
                    </Stack>
                  }
                >
                  {warnings.map((line) => (
                    <Box key={line}>{line}</Box>
                  ))}
                </Alert>
              )}
              {failure?.kind === 'forbidden' && <Alert severity="error">{HEALTH_DATA_UNAVAILABLE}</Alert>}
              {failure?.kind === 'rejected' && <Alert severity="error">{failure.message}</Alert>}
              {failure?.kind === 'network' && (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      disabled={saving}
                      onClick={() => lastPayload.current && void send(lastPayload.current)}
                    >
                      Retry
                    </Button>
                  }
                >
                  Could not save. Check your connection and try again.
                </Alert>
              )}
            </Box>
          )}

          <DialogActions>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={saving || !catalog || hasErrors || !!warnings}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Snackbar
        open={savedOpen}
        autoHideDuration={3000}
        onClose={() => setSavedOpen(false)}
        message="Saved"
      />
    </>
  );
}

export default LogMeasurementDialog;
