/**
 * One `lab_report` result inside the lab review, H4 (#188): the read view
 * (`LabResultView`), the editor used by Edit and "Add missing value"
 * (`LabResultEditor`), and the searchable analyte picker (`AnalytePicker`)
 * that maps an unmatched result to a catalog analyte.
 *
 * Every analyte, unit and panel comes from the API's catalog
 * (`GET /api/measurements/metrics`, category `lab`, with its aliases); nothing
 * is copied here. The server matches, converts and validates on every write.
 */
import { useId, useState } from 'react';
import { Autocomplete, Box, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { MetricCatalog, MetricDef } from '../../services/health';
import {
  LAB_FLAGS,
  LAB_FLAG_LABELS,
  LAB_NAME_MAX,
  analyteMatches,
  formatLabNumber,
  labMetrics,
  referenceRangeText,
  type LabFlag,
  type LabReportValue,
} from '../../services/labReport';
import { parseDecimal, withUnit } from '../../utils/measurementUnits';
import { formatLabValue } from '../../utils/biomarkers';
import { DEFAULT_LAB_UNITS, convertLabRange, labDisplay, labDisplayUnit, type LabUnits } from '../../utils/labUnits';

function findAnalyte(catalog: MetricCatalog | null, key: string | null): MetricDef | undefined {
  if (!key) return undefined;
  return catalog?.metrics.find((metric) => metric.key === key);
}

const FLAG_COLOR: Record<LabFlag, 'default' | 'success' | 'warning' | 'error'> = {
  low: 'warning',
  normal: 'success',
  high: 'warning',
  critical: 'error',
  unknown: 'default',
};

/** The lab's flag as a chip; text carries the meaning, colour only repeats it. */
export function LabFlagChip({ flag }: { flag: LabFlag | null }) {
  if (!flag) return null;
  return <Chip size="small" variant="outlined" color={FLAG_COLOR[flag]} label={`Flag: ${LAB_FLAG_LABELS[flag]}`} />;
}

const MATCH_LABEL: Record<LabReportValue['match'], string | null> = {
  matched: null,
  suggested: 'Suggested match',
  user_mapped: 'Mapped by you',
  unmatched: 'Not in catalog',
};

/**
 * `renderValue`: the printed name, the analyte it is saved as, value, range and
 * flag. A canonical value is SHOWN in the `labUnits` preference (#234); what
 * is saved does not change.
 */
export function LabResultView({
  value,
  catalog,
  labUnits = DEFAULT_LAB_UNITS,
}: {
  value: LabReportValue;
  catalog: MetricCatalog | null;
  labUnits?: LabUnits;
}) {
  const analyte = findAnalyte(catalog, value.analyteKey);
  const printed = value.nameAsPrinted ?? analyte?.label ?? 'Unnamed result';
  // Only a canonical value converts with the catalog's canonical factors.
  const display = analyte && value.unit === analyte.canonicalUnit ? labDisplay(analyte, labUnits) : null;
  const shown = display?.converted ? display : null;
  const number =
    value.value !== null
      ? shown
        ? withUnit(formatLabValue(shown.value(value.value), shown.decimals), shown.unit)
        : withUnit(formatLabNumber(value.value), value.unit ?? '').trim()
      : (value.valueText ?? '—');
  const converted =
    value.originalValue !== null &&
    value.originalUnit !== null &&
    (value.originalUnit !== value.unit || value.originalValue !== value.value);
  const range = referenceRangeText(shown ? convertLabRange(value, shown) : value);
  const matchLabel = MATCH_LABEL[value.match] ?? null;

  return (
    <Box component="span" sx={{ display: 'block' }} data-testid="lab-result-value">
      <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 1 }}>
        <Box component="span" sx={{ fontWeight: 600 }}>
          {printed}
        </Box>
        <Box component="span" sx={{ fontWeight: 600 }} data-testid="lab-result-number">
          {number}
        </Box>
      </Box>
      <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
        {analyte ? (
          <>Saved as {analyte.label}</>
        ) : (
          <Box component="span" sx={{ color: 'warning.main', fontWeight: 600 }}>
            Not matched to an analyte
          </Box>
        )}
        {converted && (
          <span data-testid="lab-result-original">
            {' '}
            · Printed {withUnit(formatLabNumber(value.originalValue!), value.originalUnit!)}
          </span>
        )}
        {range && <span> · Range {range}</span>}
        {value.value !== null && value.valueText && <span> · “{value.valueText}”</span>}
      </Typography>
      {(value.flag || matchLabel) && (
        <Stack component="span" direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
          <LabFlagChip flag={value.flag} />
          {matchLabel && (
            <Chip
              size="small"
              variant="outlined"
              color={value.match === 'user_mapped' ? 'primary' : 'warning'}
              label={matchLabel}
            />
          )}
        </Stack>
      )}
    </Box>
  );
}

export interface AnalytePickerProps {
  catalog: MetricCatalog | null;
  value: string | null;
  onChange: (analyteKey: string | null) => void;
  label?: string;
  disabled?: boolean;
  /** A short id-safe name for the input (tests, a11y). */
  id?: string;
}

/** Search the lab catalog by label, key or any alias a lab prints. */
export function AnalytePicker({ catalog, value, onChange, label = 'Analyte', disabled, id }: AnalytePickerProps) {
  const options = labMetrics(catalog);
  const selected = options.find((metric) => metric.key === value) ?? null;
  return (
    <Autocomplete
      id={id}
      size="small"
      options={options}
      value={selected}
      disabled={disabled}
      onChange={(_event, next) => onChange(next?.key ?? null)}
      getOptionLabel={(metric) => metric.label}
      isOptionEqualToValue={(a, b) => a.key === b.key}
      filterOptions={(all, state) => all.filter((metric) => analyteMatches(metric, state.inputValue))}
      renderOption={(props, metric) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <li key={key} {...rest}>
            <Box>
              <Box>{metric.label}</Box>
              {metric.aliases && metric.aliases.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  {metric.aliases.slice(0, 4).join(', ')}
                </Typography>
              )}
            </Box>
          </li>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} placeholder="Search by name or abbreviation" />}
      fullWidth
    />
  );
}

/** A decimal field that keeps what the user typed and reports `number | null`. */
function NumberField({
  label,
  value,
  onChange,
  id,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  id: string;
}) {
  const [text, setText] = useState(() => (value === null ? '' : String(value)));
  const invalid = text.trim() !== '' && parseDecimal(text) === null;
  return (
    <TextField
      id={id}
      size="small"
      label={label}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const trimmed = event.target.value.trim();
        if (trimmed === '') onChange(null);
        else {
          const parsed = parseDecimal(trimmed);
          if (parsed !== null) onChange(parsed);
        }
      }}
      error={invalid}
      helperText={invalid ? 'Enter a number' : undefined}
      autoComplete="off"
      sx={{ flex: 1, minWidth: 0 }}
      slotProps={{ htmlInput: { inputMode: 'decimal' } }}
    />
  );
}

export interface LabResultEditorProps {
  value: LabReportValue;
  onChange: (value: LabReportValue) => void;
  catalog: MetricCatalog | null;
  /** #234: the unit picked for a newly chosen analyte. The value is sent in whatever unit is picked. */
  labUnits?: LabUnits;
}

/**
 * `renderEditor`: analyte, value and unit (any unit the analyte accepts; the
 * server converts), reference range, the printed range text and the flag.
 */
export function LabResultEditor({ value, onChange, catalog, labUnits = DEFAULT_LAB_UNITS }: LabResultEditorProps) {
  const id = useId();
  const analyte = findAnalyte(catalog, value.analyteKey);
  const units = analyte?.units ?? [];

  const changeAnalyte = (key: string | null) => {
    const next = findAnalyte(catalog, key);
    const unitAllowed = next ? next.units.some((unit) => unit.unit === value.unit) : true;
    // A unit the new analyte does not accept (or none yet) becomes the preferred one.
    onChange({ ...value, analyteKey: key, unit: next && !unitAllowed ? labDisplayUnit(next, labUnits).unit : value.unit });
  };

  const unitValue = analyte ? (units.some((unit) => unit.unit === value.unit) ? value.unit! : '') : (value.unit ?? '');

  return (
    <Stack spacing={1.5} data-testid="lab-result-editor">
      <AnalytePicker id={`${id}-analyte`} catalog={catalog} value={value.analyteKey} onChange={changeAnalyte} />
      <TextField
        id={`${id}-name`}
        size="small"
        label="Name as printed"
        value={value.nameAsPrinted ?? ''}
        onChange={(event) => onChange({ ...value, nameAsPrinted: event.target.value === '' ? null : event.target.value })}
        slotProps={{ htmlInput: { maxLength: LAB_NAME_MAX } }}
        fullWidth
      />
      <Stack direction="row" spacing={1}>
        <NumberField id={`${id}-value`} label="Value" value={value.value} onChange={(next) => onChange({ ...value, value: next })} />
        {analyte ? (
          <TextField
            id={`${id}-unit`}
            select
            size="small"
            label="Unit"
            value={unitValue}
            onChange={(event) => onChange({ ...value, unit: event.target.value })}
            sx={{ width: 130, flexShrink: 0 }}
          >
            {units.map((unit) => (
              <MenuItem key={unit.unit} value={unit.unit}>
                {unit.label}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <TextField
            id={`${id}-unit`}
            size="small"
            label="Unit"
            value={unitValue}
            onChange={(event) => onChange({ ...value, unit: event.target.value === '' ? null : event.target.value })}
            sx={{ width: 130, flexShrink: 0 }}
          />
        )}
      </Stack>
      <Stack direction="row" spacing={1}>
        <NumberField
          id={`${id}-low`}
          label="Range low"
          value={value.referenceLow}
          onChange={(next) => onChange({ ...value, referenceLow: next })}
        />
        <NumberField
          id={`${id}-high`}
          label="Range high"
          value={value.referenceHigh}
          onChange={(next) => onChange({ ...value, referenceHigh: next })}
        />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField
          id={`${id}-range-text`}
          size="small"
          label="Range as printed"
          value={value.referenceText ?? ''}
          onChange={(event) => onChange({ ...value, referenceText: event.target.value === '' ? null : event.target.value })}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <TextField
          id={`${id}-flag`}
          select
          size="small"
          label="Flag"
          value={value.flag ?? ''}
          onChange={(event) => onChange({ ...value, flag: event.target.value === '' ? null : (event.target.value as LabFlag) })}
          sx={{ width: { xs: '100%', sm: 150 }, flexShrink: 0 }}
        >
          <MenuItem value="">
            <em>None</em>
          </MenuItem>
          {LAB_FLAGS.map((flag) => (
            <MenuItem key={flag} value={flag}>
              {LAB_FLAG_LABELS[flag]}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
    </Stack>
  );
}
