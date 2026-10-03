/**
 * The quick-entry dialog for body and vital measurements, issue #53 (E2.3).
 *
 * One short form for the body and vital metrics. A row of toggle chips picks
 * which metrics this entry covers (one, or several at once; the initial
 * choice is the metric of the tile that opened the dialog, else Weight), and
 * only the chosen metrics show their fields. The date and time sit right under
 * the chips, so backfilling history needs no extra step. Only filled fields of
 * the chosen metrics become readings of ONE entry (`POST /api/measurements`).
 * Logging a weight is: open, type, Enter. "Save and add another" saves, keeps
 * the dialog open with the same metrics and date, and clears the values, for
 * entering history one reading after another.
 *
 * Units are the user's (`unitSystem` from the health profile) and every unit,
 * factor and bound comes from the API's catalog (`useMeasurementCatalog`);
 * the dialog sends `{ value, unit }` in the unit shown and the API converts.
 * The checks here explain a problem before the round trip; the API decides.
 *
 * Edit mode (issue #60, E2.5): given an `entry`, the same form is prefilled
 * with that entry's readings only (in the user's units), its methods, time
 * and note, titled "Edit entry", and saves with
 * `PATCH /api/measurements/entries/:entryId` carrying ONLY what changed. An
 * unchanged form closes without a request. A changed value shows what it was
 * ("Was 80.0 kg"), read off the row the dialog was opened with.
 *
 * Read from photo (issue #64, E2.6): a new entry offers a link-style "Read
 * from photo" at the top when the photo flow is available; the page opens
 * `PhotoReadDialog` over this one, so nothing typed here is lost.
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
  Chip,
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
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link as RouterLink } from 'react-router-dom';
import { ApiError } from '../../services/api';
import {
  createMeasurementEntry,
  HEALTH_DATA_UNAVAILABLE,
  isEntryConflict,
  isEntryGone,
  isHealthDataForbidden,
  updateMeasurementEntry,
  UNSPECIFIED_METHOD,
  validationIssues,
  type CreateMeasurementEntryInput,
  type HealthProfile,
  type MeasurementReadingInput,
  type UpdateMeasurementEntryInput,
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
  formatNumber,
  fromDisplay,
  parseDecimal,
  percentDifference,
  toDisplay,
  withUnit,
} from '../../utils/measurementUnits';
import type { HistoryEntry } from '../../utils/measurementSeries';
import { PhotoReadButton } from './PhotoReadButton';
import {
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../../utils/measurementDates';

/**
 * A reading more than this far (percent) from the metric's latest one asks
 * "Check the unit". A new entry dated before that latest reading (backfilled
 * history) is never compared with it.
 */
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

/** The chip selected when the dialog opens: the focused metric's group, else Weight. */
function initialGroupId(focusMetric?: MetricKey): string {
  return GROUP_OF[focusMetric ?? 'weight'];
}

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
  /**
   * Edit mode: the entry (a History row) to change. Only its metrics are
   * shown, prefilled; saving PATCHes only what changed.
   */
  entry?: HistoryEntry | null;
  /**
   * Edit mode: the entry could not be saved because it is no longer what the
   * dialog was opened with. `gone` = `404` (deleted elsewhere), `conflict` =
   * `409` (changed elsewhere). The dialog closes; the caller reloads and says so.
   */
  onStale?: (reason: 'gone' | 'conflict') => void;
  /**
   * Issue #64 (E2.6): open the photo-read flow on top of this dialog (what
   * was typed here stays). A link-style "Read from photo" is shown at the top
   * of a NEW entry when given and `useCanReadFromPhoto()` holds; never in
   * edit mode.
   */
  onReadFromPhoto?: () => void;
}

/** What a submit sends: a new entry, or the changes to an existing one. */
type Payload =
  | { mode: 'create'; body: CreateMeasurementEntryInput }
  | { mode: 'edit'; entryId: string; body: UpdateMeasurementEntryInput };

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
  entry = null,
  onStale,
  onReadFromPhoto,
}: LogMeasurementDialogProps) {
  const isEdit = entry !== null;
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
  // New-entry mode: the metric groups (ids of METHOD_GROUPS) chosen with the chips.
  const [selected, setSelected] = useState<string[]>(() => [initialGroupId(focusMetric)]);
  // A field to focus once it is rendered and enabled (a newly chosen chip, or a cleared form).
  const [focusRequest, setFocusRequest] = useState<MetricKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const savingRef = useRef(false);
  // Which button started the current save, so "Save anyway" and Retry continue the same action.
  const addAnotherRef = useRef(false);
  const lastPayload = useRef<Payload | null>(null);
  // Edit mode: what the form held when it was prefilled, to diff against.
  const [original, setOriginal] = useState<{
    values: Values;
    methods: Record<string, string>;
    measuredAtText: string;
    notes: string;
  } | null>(null);
  const prefilled = useRef(false);
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
    setSelected([initialGroupId(focusMetric)]);
    setFocusRequest(null);
    addAnotherRef.current = false;
    setWarnings(null);
    setFailure(null);
    setOriginal(null);
    prefilled.current = false;
    lastPayload.current = null;
    const defaults: Record<string, string> = {};
    for (const group of METHOD_GROUPS) {
      defaults[group.id] = latestByKey.get(group.keys[0])?.latest?.method ?? UNSPECIFIED_METHOD;
    }
    setMethods(defaults);
    // `latestByKey` is read once per opening on purpose: a refetch while the
    // form is open must not overwrite a method the user picked.
  }, [open]);

  // Edit mode: prefill once per opening, as soon as the catalog (the units)
  // is there. The entry is read at that moment only: a History refetch while
  // the form is open must not overwrite what the user typed.
  useEffect(() => {
    if (!open || !entry || !catalog || prefilled.current) return;
    prefilled.current = true;
    const nextValues: Values = { ...EMPTY_VALUES };
    const nextMethods: Record<string, string> = {};
    for (const reading of entry.readings) {
      const key = reading.metricKey as MetricKey;
      const metric = metricsByKey.get(key);
      if (!metric || !(key in EMPTY_VALUES)) continue;
      nextValues[key] = formatNumber(metric, toDisplay(metric, reading.value, unitSystem));
      nextMethods[GROUP_OF[key]] = reading.method;
    }
    const at = toDateTimeLocalValue(new Date(entry.measuredAt));
    const note = entry.notes ?? '';
    setValues(nextValues);
    setMethods((prev) => ({ ...prev, ...nextMethods }));
    setMeasuredAtText(at);
    setNotes(note);
    setDetailsOpen(true);
    setOriginal({ values: nextValues, methods: { ...nextMethods }, measuredAtText: at, notes: note });
  }, [open, entry, catalog, metricsByKey, unitSystem]);

  /** Edit mode: the metric keys the entry holds; create mode: the keys of the chosen chips. */
  const shownKeys = useMemo(() => {
    if (!entry) {
      return new Set<MetricKey>(
        METHOD_GROUPS.filter((group) => selected.includes(group.id)).flatMap((group) => group.keys),
      );
    }
    return new Set(entry.readings.map((r) => r.metricKey as MetricKey));
  }, [entry, selected]);

  // Focus a field once it exists and is enabled (never while a save is in flight).
  useEffect(() => {
    if (!focusRequest || saving) return;
    document.getElementById(`${idBase}-${focusRequest}`)?.focus();
    setFocusRequest(null);
  }, [focusRequest, saving, idBase]);

  const originalReading = (key: MetricKey) => entry?.readings.find((r) => r.metricKey === key);

  /** Edit mode: the typed value differs from the prefilled one. */
  const valueChanged = (key: MetricKey): boolean => {
    if (!original) return false;
    const before = parseDecimal(original.values[key]);
    const now = parseDecimal(values[key]);
    return now !== before;
  };

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
      if (!shownKeys.has(key)) continue;
      if (isEdit && !isFilled(values[key])) {
        next[key] = 'Enter a value';
        continue;
      }
      const problem = fieldProblem(key, values[key]);
      if (problem) next[key] = problem;
    }

    const hasSystolic = isFilled(values.bp_systolic);
    const hasDiastolic = isFilled(values.bp_diastolic);
    if (hasSystolic && !hasDiastolic) next.bp_diastolic = next.bp_diastolic ?? 'Enter both numbers';
    if (!hasSystolic && hasDiastolic) next.bp_systolic = next.bp_systolic ?? 'Enter both numbers';
    if (hasSystolic && hasDiastolic && !next.bp_systolic && !next.bp_diastolic) {
      const systolic = parseDecimal(values.bp_systolic)!;
      const diastolic = parseDecimal(values.bp_diastolic)!;
      if (systolic <= diastolic) next.bp_systolic = 'Systolic must be higher than diastolic';
    }

    if (!isEdit && !FIELDS.some(({ key }) => shownKeys.has(key) && isFilled(values[key]))) {
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
  }, [fieldProblem, values, measuredAtTouched, measuredAtText, notes, isEdit, shownKeys]);

  const hasErrors = Object.values(errors).some(Boolean);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const buildCreate = (): CreateMeasurementEntryInput => {
    const readings = FIELDS.filter(({ key }) => shownKeys.has(key) && isFilled(values[key])).map(({ key }) => {
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

  /**
   * Edit mode: only what changed, or `null` when nothing did. A changed value
   * is sent in the unit shown; a reading whose METHOD alone changed is sent
   * with its stored canonical value and unit, so re-saving never re-rounds it.
   */
  const buildPatch = (): UpdateMeasurementEntryInput | null => {
    if (!entry || !original) return null;
    const readings: MeasurementReadingInput[] = [];
    for (const { key } of FIELDS) {
      if (!shownKeys.has(key)) continue;
      const metric = metricsByKey.get(key);
      const stored = originalReading(key);
      if (!metric || !stored) continue;
      const method = methods[GROUP_OF[key]];
      const methodChanged = method !== undefined && method !== original.methods[GROUP_OF[key]];
      if (valueChanged(key)) {
        readings.push({
          metricKey: key,
          value: parseDecimal(values[key])!,
          unit: displayUnit(metric, unitSystem),
          ...(methodChanged ? { method } : {}),
        });
      } else if (methodChanged) {
        readings.push({ metricKey: key, value: stored.value, unit: stored.unit, method });
      }
    }
    const patch: UpdateMeasurementEntryInput = {};
    if (readings.length > 0) patch.readings = readings;
    if (measuredAtTouched && measuredAtText !== original.measuredAtText) {
      patch.measuredAt = parseDateTimeLocalValue(measuredAtText)!.toISOString();
    }
    const trimmed = notes.trim();
    if (trimmed !== original.notes.trim()) patch.notes = trimmed === '' ? null : trimmed;
    return Object.keys(patch).length > 0 ? patch : null;
  };

  const softWarnings = (readingsToCheck: MeasurementReadingInput[]): string[] => {
    const lines: string[] = [];
    for (const reading of readingsToCheck) {
      const metric = metricsByKey.get(reading.metricKey);
      // Edit mode compares with the value being replaced; a method-only
      // change (sent in the canonical unit) is not a new number.
      if (isEdit && !valueChanged(reading.metricKey as MetricKey)) continue;
      const previous = isEdit
        ? originalReading(reading.metricKey as MetricKey)
        : latestByKey.get(reading.metricKey)?.latest;
      if (!metric || !previous) continue;
      // A backdated entry (older than the metric's latest reading) is history
      // being backfilled: "your last entry" would be a later reading, so the
      // comparison is meaningless and would warn on every legitimate old value.
      if (!isEdit) {
        const entryTime =
          (measuredAtTouched ? parseDateTimeLocalValue(measuredAtText) : null) ?? new Date();
        if (entryTime.getTime() < new Date(previous.measuredAt).getTime()) continue;
      }
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
        if (readingsToCheck.length > 1) {
          lines[lines.length - 1] = `${FIELD_LABEL[reading.metricKey as MetricKey]}: ${lines[lines.length - 1]}`;
        }
      }
    }
    return lines;
  };

  const applyServerIssues = (err: unknown, payload: { readings?: Array<{ metricKey: string }> }): boolean => {
    const issues = validationIssues(err);
    if (issues.length === 0) return false;
    const next: Errors = {};
    let openDetails = false;
    for (const issue of issues) {
      const [head, index, field] = issue.path.split('.');
      if (head === 'readings' && index !== undefined) {
        const key = payload.readings?.[Number(index)]?.metricKey as MetricKey | undefined;
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
        // The date is always visible; only the note lives in Details.
        if (head === 'notes') openDetails = true;
      } else {
        next.form = next.form ?? issue.message;
      }
    }
    setErrors(next);
    if (openDetails) setDetailsOpen(true);
    return true;
  };

  const send = async (payload: Payload) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    setWarnings(null);
    lastPayload.current = payload;
    try {
      const saved =
        payload.mode === 'create'
          ? await createMeasurementEntry(payload.body)
          : await updateMeasurementEntry(payload.entryId, payload.body);
      onSaved(saved.items);
      setSavedOpen(true);
      if (addAnotherRef.current && payload.mode === 'create') {
        // Keep the dialog, the chosen metrics, the date and the methods; clear what was typed.
        setValues(EMPTY_VALUES);
        setErrors({});
        setWarnings(null);
        setFailure(null);
        setNotes('');
        setFocusRequest(FIELDS.find(({ key }) => shownKeys.has(key))?.key ?? null);
      } else {
        onClose();
      }
    } catch (err) {
      if (payload.mode === 'edit' && (isEntryGone(err) || isEntryConflict(err))) {
        onStale?.(isEntryGone(err) ? 'gone' : 'conflict');
        onClose();
      } else if (isHealthDataForbidden(err)) {
        setFailure({ kind: 'forbidden' });
      } else if (applyServerIssues(err, payload.body)) {
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

  const submit = (confirmed: boolean, addAnother = false) => {
    if (savingRef.current || !catalog) return;
    addAnotherRef.current = addAnother && !isEdit;
    const found = validate();
    setErrors(found);
    if (found.notes) setDetailsOpen(true);
    if (Object.values(found).some(Boolean)) return;

    let payload: Payload;
    if (isEdit) {
      const patch = buildPatch();
      if (!patch) {
        // Nothing changed: nothing to send.
        onClose();
        return;
      }
      payload = { mode: 'edit', entryId: entry!.entryId, body: patch };
    } else {
      payload = { mode: 'create', body: buildCreate() };
    }
    if (!confirmed) {
      const lines = softWarnings(payload.body.readings ?? []);
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

  /** New-entry mode: choose or drop a metric. Dropping clears what was typed for it. */
  const toggleGroup = (groupId: string) => {
    const group = METHOD_GROUPS.find((g) => g.id === groupId);
    if (!group) return;
    setWarnings(null);
    if (selected.includes(groupId)) {
      setSelected((prev) => prev.filter((id) => id !== groupId));
      setValues((prev) => {
        const next = { ...prev };
        for (const key of group.keys) next[key] = '';
        return next;
      });
      setErrors((prev) => {
        const next = { ...prev, form: undefined };
        for (const key of group.keys) next[key] = undefined;
        return next;
      });
    } else {
      setSelected((prev) => [...prev, groupId]);
      setErrors((prev) => ({ ...prev, form: undefined }));
      setFocusRequest(group.keys[0]);
    }
  };

  const requestedFocus: MetricKey =
    focusMetric === 'bp_diastolic' ? 'bp_systolic' : (focusMetric ?? 'weight');
  // Edit mode focuses the entry's first metric when the requested one is not shown.
  const autoFocusKey: MetricKey = shownKeys.has(requestedFocus)
    ? requestedFocus
    : (FIELDS.find(({ key }) => shownKeys.has(key))?.key ?? 'weight');

  const renderField = (key: MetricKey) => {
    const metric = metricsByKey.get(key);
    const unit = metric ? displayUnit(metric, unitSystem) : '';
    const id = `${idBase}-${key}`;
    const stored = isEdit ? originalReading(key) : undefined;
    const wasHint =
      metric && stored && isFilled(values[key]) && valueChanged(key)
        ? `Was ${formatMeasurement(metric, stored.value, unitSystem)}`
        : undefined;
    return (
      <TextField
        key={key}
        id={id}
        label={FIELD_LABEL[key]}
        value={values[key]}
        onChange={(event) => onValueChange(key, event.target.value)}
        onBlur={() => onValueBlur(key)}
        error={!!errors[key]}
        helperText={errors[key] ?? wasHint}
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

  // One Method select per metric shown: the entry's own (edit) or the chosen chips (new).
  const methodGroups = METHOD_GROUPS.filter((group) => group.keys.some((key) => shownKeys.has(key)));
  const show = (key: MetricKey) => shownKeys.has(key);

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
          <DialogTitle id={`${idBase}-title`}>{isEdit ? 'Edit entry' : 'Log measurement'}</DialogTitle>
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
                {!isEdit && onReadFromPhoto && (
                  <Box>
                    <PhotoReadButton
                      variant="text"
                      size="small"
                      onClick={onReadFromPhoto}
                      disabled={saving}
                      sx={{ px: 0.5 }}
                    />
                  </Box>
                )}
                {profileMissing && (
                  <Typography variant="body2" color="text.secondary">
                    Using metric units.{' '}
                    <Link component={RouterLink} to="/settings/health-profile">
                      Change in Health Profile
                    </Link>
                  </Typography>
                )}

                {!isEdit && (
                  <Stack
                    direction="row"
                    useFlexGap
                    sx={{ flexWrap: 'wrap', gap: 1 }}
                    role="group"
                    aria-label="Measurements to log"
                  >
                    {METHOD_GROUPS.map((group) => {
                      const isOn = selected.includes(group.id);
                      return (
                        <Chip
                          key={group.id}
                          label={group.label}
                          clickable
                          onClick={() => toggleGroup(group.id)}
                          color={isOn ? 'primary' : 'default'}
                          variant={isOn ? 'filled' : 'outlined'}
                          icon={isOn ? <CheckIcon /> : undefined}
                          aria-pressed={isOn}
                          disabled={saving}
                          data-testid={`metric-chip-${group.id}`}
                        />
                      );
                    })}
                  </Stack>
                )}

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

                {show('weight') && renderField('weight')}
                {show('body_fat_pct') && renderField('body_fat_pct')}
                {show('waist_circumference') && renderField('waist_circumference')}

                {(show('bp_systolic') || show('bp_diastolic')) && (
                  <Box role="group" aria-labelledby={`${idBase}-bp`}>
                    <Typography id={`${idBase}-bp`} variant="subtitle2" component="p" sx={{ mb: 1 }}>
                      Blood pressure
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                      {show('bp_systolic') && renderField('bp_systolic')}
                      {show('bp_diastolic') && renderField('bp_diastolic')}
                    </Box>
                  </Box>
                )}

                {show('resting_hr') && renderField('resting_hr')}

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
                      {methodGroups.length === 0 && (
                        <Typography variant="body2" color="text.secondary">
                          Choose a metric to pick how it was measured.
                        </Typography>
                      )}
                      {methodGroups.map((group) => {
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
                      <Button
                        color="inherit"
                        size="small"
                        variant="outlined"
                        sx={{ fontWeight: 700 }}
                        onClick={() => submit(true, addAnotherRef.current)}
                      >
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
            {!isEdit && (
              <Button
                variant="outlined"
                onClick={() => submit(false, true)}
                disabled={saving || !catalog || hasErrors || !!warnings}
              >
                Save and add another
              </Button>
            )}
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
