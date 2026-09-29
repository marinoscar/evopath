/**
 * The `body_metric_reading` value inside the E3.1 review list, issue #64
 * (E2.6): `readingText` / `ReadingValue` are `AiDraftReview`'s `renderValue`
 * and `ReadingEditor` its `renderEditor` (edit an item, "Add missing item").
 *
 * A draft reading is shown AS DISPLAYED ON THE DEVICE (its own unit, not the
 * profile's); the API converts it once, at apply. Every metric, unit, method
 * and bound comes from the API's catalog (`useMeasurementCatalog`); nothing is
 * copied here. The editor's checks explain a problem early; the API decides.
 */
import { useId, useState } from 'react';
import { MenuItem, Stack, TextField } from '@mui/material';
import {
  QUICK_ENTRY_METRIC_KEYS,
  UNSPECIFIED_METHOD,
  type BodyMetricReadingValue,
  type MetricCatalog,
  type MetricDef,
  type MetricKey,
  type UnitSystem,
} from '../../services/health';
import { displayUnit, parseDecimal, withUnit } from '../../utils/measurementUnits';

/** How a reading's metric reads in the review: the pair is named as a pair. */
export function readingLabel(metricKey: string, metric: MetricDef | undefined): string {
  if (metricKey === 'bp_systolic') return 'Blood pressure: systolic';
  if (metricKey === 'bp_diastolic') return 'Blood pressure: diastolic';
  return metric?.label ?? metricKey;
}

function findMetric(catalog: MetricCatalog | null, key: string): MetricDef | undefined {
  return catalog?.metrics.find((metric) => metric.key === key);
}

/** `Weight 208.4 lb`, `Blood pressure: systolic 128 mmHg`, `Body fat 27.8%`. */
export function readingText(value: BodyMetricReadingValue, catalog: MetricCatalog | null): string {
  const metric = findMetric(catalog, value.metricKey);
  const number = Number.isFinite(value.value) ? String(value.value) : '—';
  return `${readingLabel(value.metricKey, metric)} ${withUnit(number, value.unit)}`;
}

/** The method's catalog label, or `null` for none / `unspecified`. */
export function readingMethodLabel(value: BodyMetricReadingValue, catalog: MetricCatalog | null): string | null {
  if (!value.method || value.method === UNSPECIFIED_METHOD) return null;
  return catalog?.methods.find((method) => method.key === value.method)?.label ?? value.method;
}

/** `renderValue`: inline only (the review also shows it inside "AI said: …"). */
export function ReadingValue({ value, catalog }: { value: BodyMetricReadingValue; catalog: MetricCatalog | null }) {
  const method = readingMethodLabel(value, catalog);
  return (
    <span>
      <span style={{ fontWeight: 600 }}>{readingText(value, catalog)}</span>
      {method && <span> · {method}</span>}
    </span>
  );
}

/** A metric's hard bounds in `unit`, rounded inward to its display precision. */
export function boundsInUnit(metric: MetricDef, unit: string): { min: number; max: number } | null {
  const def = metric.units.find((candidate) => candidate.unit === unit);
  if (!def) return null;
  const scale = 10 ** metric.decimals;
  return {
    min: Math.ceil((metric.min / def.factor) * scale - 1e-9) / scale,
    max: Math.floor((metric.max / def.factor) * scale + 1e-9) / scale,
  };
}

/** A problem with a draft reading the user can fix in the editor, or `null`. */
export function readingProblem(value: BodyMetricReadingValue, catalog: MetricCatalog | null): string | null {
  if (!Number.isFinite(value.value)) return 'Enter a number';
  const metric = findMetric(catalog, value.metricKey);
  if (!metric) return null;
  const bounds = boundsInUnit(metric, value.unit);
  if (!bounds) return 'Choose a unit';
  if (value.value < bounds.min || value.value > bounds.max) {
    return `Enter a value between ${bounds.min} and ${withUnit(String(bounds.max), value.unit)}`;
  }
  return null;
}

/** The starting value of "Add missing item": weight, in the user's unit. */
export function emptyReading(catalog: MetricCatalog | null, unitSystem: UnitSystem): BodyMetricReadingValue {
  const weight = findMetric(catalog, 'weight');
  return { metricKey: 'weight', value: Number.NaN, unit: weight ? displayUnit(weight, unitSystem) : 'kg' };
}

export interface ReadingEditorProps {
  value: BodyMetricReadingValue;
  onChange: (value: BodyMetricReadingValue) => void;
  catalog: MetricCatalog | null;
  unitSystem: UnitSystem;
}

/** `renderEditor`: metric, number, unit (the device's) and method, all from the catalog. */
export function ReadingEditor({ value, onChange, catalog, unitSystem }: ReadingEditorProps) {
  const id = useId();
  const [text, setText] = useState(() => (Number.isFinite(value.value) ? String(value.value) : ''));
  const [touched, setTouched] = useState(false);
  const metric = findMetric(catalog, value.metricKey);
  const metrics = QUICK_ENTRY_METRIC_KEYS.map((key) => findMetric(catalog, key)).filter(
    (candidate): candidate is MetricDef => candidate !== undefined,
  );
  const methodLabel = (key: string) => catalog?.methods.find((method) => method.key === key)?.label ?? key;
  const problem = touched || Number.isFinite(value.value) ? readingProblem(value, catalog) : null;

  const changeMetric = (key: MetricKey) => {
    const next = findMetric(catalog, key);
    if (!next) return;
    const unitAllowed = next.units.some((unit) => unit.unit === value.unit);
    const methodAllowed = value.method !== undefined && next.methods.includes(value.method);
    onChange({
      metricKey: key,
      value: value.value,
      unit: unitAllowed ? value.unit : displayUnit(next, unitSystem),
      ...(methodAllowed ? { method: value.method } : {}),
    });
  };

  const changeText = (next: string) => {
    setText(next);
    const parsed = parseDecimal(next);
    onChange({ ...value, value: parsed ?? Number.NaN });
  };

  const changeMethod = (method: string) => {
    const { method: _previous, ...rest } = value;
    onChange(method === UNSPECIFIED_METHOD ? rest : { ...rest, method });
  };

  return (
    <Stack spacing={1.5} data-testid="reading-editor">
      <TextField
        id={`${id}-metric`}
        select
        size="small"
        label="Measurement"
        value={value.metricKey}
        onChange={(event) => changeMetric(event.target.value as MetricKey)}
        fullWidth
      >
        {metrics.map((candidate) => (
          <MenuItem key={candidate.key} value={candidate.key}>
            {candidate.label}
          </MenuItem>
        ))}
      </TextField>
      <Stack direction="row" spacing={1}>
        <TextField
          id={`${id}-value`}
          size="small"
          label="Value"
          value={text}
          onChange={(event) => changeText(event.target.value)}
          onBlur={() => setTouched(true)}
          error={problem !== null}
          helperText={problem ?? ' '}
          autoComplete="off"
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        <TextField
          id={`${id}-unit`}
          select
          size="small"
          label="Unit"
          value={metric?.units.some((unit) => unit.unit === value.unit) ? value.unit : ''}
          onChange={(event) => onChange({ ...value, unit: event.target.value })}
          sx={{ width: 110, flexShrink: 0 }}
        >
          {(metric?.units ?? []).map((unit) => (
            <MenuItem key={unit.unit} value={unit.unit}>
              {unit.label}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <TextField
        id={`${id}-method`}
        select
        size="small"
        label="Method"
        value={value.method ?? UNSPECIFIED_METHOD}
        onChange={(event) => changeMethod(event.target.value)}
        fullWidth
      >
        {(metric?.methods ?? [UNSPECIFIED_METHOD]).map((method) => (
          <MenuItem key={method} value={method}>
            {methodLabel(method)}
          </MenuItem>
        ))}
      </TextField>
    </Stack>
  );
}
