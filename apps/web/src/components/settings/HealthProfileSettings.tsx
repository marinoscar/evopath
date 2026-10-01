/**
 * The Health Profile form (`/settings/health-profile`), issue #47 (E2.1).
 *
 * A controlled form over one `HealthProfile`. It presents and collects; the
 * API's Zod schema decides what is valid. The checks below only explain a
 * problem before the round trip.
 *
 * HEIGHT KEEPS ONE CANONICAL VALUE, `heightMm`. The text fields are a view of
 * it in the chosen units. Switching units re-renders the text from `heightMm`
 * and never parses it back, so Imperial → Metric → Imperial without an edit
 * cannot drift (5 ft 10 in stays 1778 mm and shows 177.8 cm). Only an edit to
 * a height field recomputes `heightMm`.
 *
 * WRITES ARE GATED HERE, not by a second card permission: without
 * `health_data:write` (`canWrite === false`) every input and Save are
 * disabled, while the card and the route stay gated on `health_data:read`.
 *
 * A `409` keeps the user's edits on screen and says so, with a Reload action;
 * every other save failure is reported through `onError`.
 */

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  InputAdornment,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  BIO_MAX_LENGTH,
  DOB_MAX_AGE_YEARS,
  HEIGHT_MM_MAX,
  HEIGHT_MM_MIN,
  LAB_UNITS_VALUES,
  isHealthProfileConflict,
  type HealthProfile,
  type HealthProfileInput,
  type LabUnits,
  type SexAtBirth,
  type UnitSystem,
} from '../../services/health';
import { ApiError } from '../../services/api';
import { cmTextToMm, feetInchesToMm, mmToCmText, mmToFeetInches } from '../../utils/heightUnits';
import { LAB_UNITS_LABELS, labUnitsOf } from '../../utils/labUnits';

export const LAB_UNITS_HELPER_TEXT =
  'How blood work is shown and exported. Your results are stored the same either way.';

export const HEALTH_PROFILE_CONFLICT_MESSAGE =
  'This profile changed elsewhere. Reload to continue.';

export const BIO_HELPER_TEXT =
  'Context for you and, later, your AI coach. It is not a medical record.';

const SEX_AT_BIRTH_OPTIONS: { value: SexAtBirth; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export interface HealthProfileSettingsProps {
  profile: HealthProfile;
  /** Holds `health_data:write`. Without it every input is disabled. */
  canWrite: boolean;
  isSaving?: boolean;
  /** Full replace. Rejects with the `ApiError` on failure. */
  onSave: (input: HealthProfileInput) => Promise<unknown>;
  /** Called after a successful save. */
  onSaved?: () => void;
  /** Called with a message for any save failure other than a `409`. */
  onError?: (message: string) => void;
  /** Reload the stored profile (offered after a `409`). */
  onReload?: () => void;
}

// ---------------------------------------------------------------------------
// Environment helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Every IANA zone the browser knows, or `null` when it cannot list them. */
export function supportedTimeZones(): string[] | null {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf !== 'function') return null;
  try {
    const zones = intl.supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : [...zones, 'UTC'];
  } catch {
    return null;
  }
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function isKnownTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Imperial for `en-US` locales, Metric otherwise. */
export function defaultUnitSystem(locale: string | undefined): UnitSystem {
  return locale?.toLowerCase() === 'en-us' ? 'imperial' : 'metric';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Today in the browser's own calendar, `YYYY-MM-DD` (never via UTC). */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function earliestDob(today: string): string {
  const year = Number(today.slice(0, 4)) - DOB_MAX_AGE_YEARS;
  return `${String(year).padStart(4, '0')}${today.slice(4)}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  dateOfBirth: string;
  sexAtBirth: SexAtBirth | '';
  unitSystem: UnitSystem;
  heightMm: number | null;
  /** Set when the height text in the current units does not parse. */
  heightInvalid: boolean;
  cmText: string;
  feetText: string;
  inchesText: string;
  timeZone: string;
  bio: string;
  labUnits: LabUnits;
}

function heightTexts(heightMm: number | null) {
  if (heightMm === null) return { cmText: '', feetText: '', inchesText: '' };
  const { feet, inches } = mmToFeetInches(heightMm);
  return { cmText: mmToCmText(heightMm), feetText: String(feet), inchesText: String(inches) };
}

function initialForm(profile: HealthProfile): FormState {
  const hasSaved = profile.version > 0;
  const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
  return {
    dateOfBirth: profile.dateOfBirth ?? '',
    sexAtBirth: profile.sexAtBirth ?? '',
    unitSystem: hasSaved ? profile.unitSystem : defaultUnitSystem(locale),
    heightMm: profile.heightMm,
    heightInvalid: false,
    ...heightTexts(profile.heightMm),
    // A suggestion only: nothing is stored until the user saves.
    timeZone: profile.timeZone ?? browserTimeZone() ?? '',
    bio: profile.bio ?? '',
    labUnits: labUnitsOf(profile),
  };
}

/** Parse the imperial fields. `undefined` = invalid, `null` = empty. */
function parseImperial(feetText: string, inchesText: string): number | null | undefined {
  const feet = feetText.trim();
  const inches = inchesText.trim();
  if (feet === '' && inches === '') return null;
  const ft = feet === '' ? 0 : Number(feet);
  const inch = inches === '' ? 0 : Number(inches);
  if (!Number.isInteger(ft) || ft < 0) return undefined;
  if (!Number.isFinite(inch) || inch < 0 || inch >= 12) return undefined;
  return feetInchesToMm(ft, inch);
}

interface FormErrors {
  dateOfBirth?: string;
  height?: string;
  timeZone?: string;
  bio?: string;
}

function validate(form: FormState, today: string): FormErrors {
  const errors: FormErrors = {};

  if (form.dateOfBirth) {
    if (!isCalendarDate(form.dateOfBirth)) {
      errors.dateOfBirth = 'Enter a valid date.';
    } else if (form.dateOfBirth > today) {
      errors.dateOfBirth = 'Date of birth cannot be in the future.';
    } else if (form.dateOfBirth < earliestDob(today)) {
      errors.dateOfBirth = `Date of birth cannot be more than ${DOB_MAX_AGE_YEARS} years ago.`;
    }
  }

  if (form.heightInvalid) {
    errors.height =
      form.unitSystem === 'imperial'
        ? 'Enter whole feet and inches below 12.'
        : 'Enter a number of centimetres.';
  } else if (
    form.heightMm !== null &&
    (form.heightMm < HEIGHT_MM_MIN || form.heightMm > HEIGHT_MM_MAX)
  ) {
    errors.height =
      form.unitSystem === 'imperial'
        ? 'Enter a height between 1 ft 8 in and 8 ft 2 in.'
        : 'Enter a height between 50 and 250 cm.';
  }

  const tz = form.timeZone.trim();
  if (tz && !isKnownTimeZone(tz)) {
    errors.timeZone = 'Enter a time zone name such as Europe/Madrid or UTC.';
  }

  if (form.bio.trim().length > BIO_MAX_LENGTH) {
    errors.bio = `Keep it to ${BIO_MAX_LENGTH} characters or fewer.`;
  }

  return errors;
}

function toInput(form: FormState): HealthProfileInput {
  const bio = form.bio.trim();
  const tz = form.timeZone.trim();
  return {
    dateOfBirth: form.dateOfBirth || null,
    sexAtBirth: form.sexAtBirth || null,
    heightMm: form.heightMm,
    unitSystem: form.unitSystem,
    timeZone: tz || null,
    bio: bio || null,
    labUnits: form.labUnits,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HealthProfileSettings({
  profile,
  canWrite,
  isSaving = false,
  onSave,
  onSaved,
  onError,
  onReload,
}: HealthProfileSettingsProps) {
  const [source, setSource] = useState(profile);
  const [form, setForm] = useState<FormState>(() => initialForm(profile));
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // A new profile (a save's result, or a reload) resets the form. Adjusting
  // state during render rather than in an effect avoids a stale first paint.
  if (source !== profile) {
    setSource(profile);
    setForm(initialForm(profile));
    setConflict(false);
  }

  const timeZones = useMemo(() => {
    const zones = supportedTimeZones();
    if (!zones) return null;
    // A stored or suggested zone the list does not carry (an alias) must still
    // be selectable, or the Autocomplete would render it blank.
    const current = form.timeZone.trim();
    return current && !zones.includes(current) ? [current, ...zones] : zones;
  }, [form.timeZone]);

  const today = localToday();
  const errors = validate(form, today);
  const hasErrors = Object.keys(errors).length > 0;
  const disabled = !canWrite || isSaving || submitting;

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleUnitChange = (_: unknown, next: UnitSystem | null) => {
    if (!next || next === form.unitSystem) return;
    // Re-render the text from the canonical value; never parse it back.
    setForm((prev) => ({
      ...prev,
      unitSystem: next,
      heightInvalid: false,
      ...heightTexts(prev.heightInvalid ? null : prev.heightMm),
      heightMm: prev.heightInvalid ? null : prev.heightMm,
    }));
  };

  const handleCmChange = (text: string) => {
    const mm = cmTextToMm(text);
    const invalid = text.trim() !== '' && mm === null;
    update({ cmText: text, heightMm: invalid ? null : mm, heightInvalid: invalid });
  };

  const handleImperialChange = (feetText: string, inchesText: string) => {
    const mm = parseImperial(feetText, inchesText);
    update({
      feetText,
      inchesText,
      heightMm: mm === undefined ? null : mm,
      heightInvalid: mm === undefined,
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || hasErrors) return;
    setSubmitting(true);
    setConflict(false);
    try {
      await onSave(toInput(form));
      onSaved?.();
    } catch (err) {
      if (isHealthProfileConflict(err)) {
        setConflict(true);
      } else {
        onError?.(
          err instanceof ApiError ? err.message : 'Failed to save your health profile',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const bioLength = form.bio.trim().length;

  return (
    <Card>
      <CardContent>
        <Box component="form" noValidate onSubmit={handleSubmit}>
          <Stack spacing={3}>
            {!canWrite && (
              <Alert severity="info">
                You can view your health profile but not change it.
              </Alert>
            )}

            {conflict && (
              <Alert
                severity="warning"
                action={
                  onReload ? (
                    <Button color="inherit" size="small" onClick={onReload}>
                      Reload
                    </Button>
                  ) : undefined
                }
              >
                {HEALTH_PROFILE_CONFLICT_MESSAGE}
              </Alert>
            )}

            <TextField
              label="Date of birth"
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => update({ dateOfBirth: e.target.value })}
              disabled={disabled}
              error={!!errors.dateOfBirth}
              helperText={errors.dateOfBirth}
              slotProps={{
                inputLabel: { shrink: true },
                htmlInput: { max: today, min: earliestDob(today) },
              }}
              fullWidth
            />

            <FormControl fullWidth disabled={disabled}>
              <InputLabel id="health-sex-at-birth-label">Sex at birth</InputLabel>
              <Select
                labelId="health-sex-at-birth-label"
                id="health-sex-at-birth"
                label="Sex at birth"
                value={form.sexAtBirth}
                onChange={(e) => update({ sexAtBirth: e.target.value as SexAtBirth | '' })}
              >
                <MenuItem value="">
                  <em>Not set</em>
                </MenuItem>
                {SEX_AT_BIRTH_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box>
              <Typography
                variant="body2"
                color="text.secondary"
                id="health-units-label"
                sx={{ mb: 1 }}
              >
                Units
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={form.unitSystem}
                onChange={handleUnitChange}
                disabled={disabled}
                aria-labelledby="health-units-label"
              >
                <ToggleButton value="metric">Metric</ToggleButton>
                <ToggleButton value="imperial">Imperial</ToggleButton>
              </ToggleButtonGroup>
            </Box>

            <Box>
              {form.unitSystem === 'metric' ? (
                <TextField
                  label="Height"
                  value={form.cmText}
                  onChange={(e) => handleCmChange(e.target.value)}
                  disabled={disabled}
                  error={!!errors.height}
                  slotProps={{
                    htmlInput: { inputMode: 'decimal' },
                    input: { endAdornment: <InputAdornment position="end">cm</InputAdornment> },
                  }}
                  sx={{ width: { xs: '100%', sm: 200 } }}
                />
              ) : (
                <Stack direction="row" spacing={2}>
                  <TextField
                    label="Height (feet)"
                    value={form.feetText}
                    onChange={(e) => handleImperialChange(e.target.value, form.inchesText)}
                    disabled={disabled}
                    error={!!errors.height}
                    slotProps={{
                      htmlInput: { inputMode: 'numeric' },
                      input: { endAdornment: <InputAdornment position="end">ft</InputAdornment> },
                    }}
                    sx={{ flex: 1, maxWidth: { sm: 160 } }}
                  />
                  <TextField
                    label="Height (inches)"
                    value={form.inchesText}
                    onChange={(e) => handleImperialChange(form.feetText, e.target.value)}
                    disabled={disabled}
                    error={!!errors.height}
                    slotProps={{
                      htmlInput: { inputMode: 'decimal' },
                      input: { endAdornment: <InputAdornment position="end">in</InputAdornment> },
                    }}
                    sx={{ flex: 1, maxWidth: { sm: 160 } }}
                  />
                </Stack>
              )}
              {errors.height && <FormHelperText error>{errors.height}</FormHelperText>}
            </Box>

            <FormControl component="fieldset" disabled={disabled}>
              <FormLabel component="legend" id="health-lab-units-label">
                Lab units
              </FormLabel>
              <RadioGroup
                name="health-lab-units"
                aria-labelledby="health-lab-units-label"
                value={form.labUnits}
                onChange={(e) => update({ labUnits: e.target.value as LabUnits })}
                aria-describedby="health-lab-units-helper"
              >
                {LAB_UNITS_VALUES.map((value) => (
                  <FormControlLabel key={value} value={value} control={<Radio />} label={LAB_UNITS_LABELS[value]} />
                ))}
              </RadioGroup>
              <FormHelperText id="health-lab-units-helper">{LAB_UNITS_HELPER_TEXT}</FormHelperText>
            </FormControl>

            {timeZones ? (
              <Autocomplete
                options={timeZones}
                value={form.timeZone || null}
                onChange={(_, value) => update({ timeZone: value ?? '' })}
                disabled={disabled}
                autoHighlight
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Time zone"
                    error={!!errors.timeZone}
                    helperText={errors.timeZone ?? 'Decides where your day starts and ends.'}
                  />
                )}
              />
            ) : (
              <TextField
                label="Time zone"
                value={form.timeZone}
                onChange={(e) => update({ timeZone: e.target.value })}
                disabled={disabled}
                error={!!errors.timeZone}
                helperText={errors.timeZone ?? 'An IANA name, such as Europe/Madrid or UTC.'}
                fullWidth
              />
            )}

            <TextField
              label="Bio"
              value={form.bio}
              onChange={(e) => update({ bio: e.target.value })}
              disabled={disabled}
              multiline
              minRows={3}
              error={!!errors.bio}
              helperText={
                <Box
                  component="span"
                  sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}
                >
                  <span>{errors.bio ?? BIO_HELPER_TEXT}</span>
                  <span>
                    {bioLength}/{BIO_MAX_LENGTH}
                  </span>
                </Box>
              }
              fullWidth
            />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="submit" variant="contained" disabled={disabled || hasErrors}>
                {isSaving || submitting ? 'Saving…' : 'Save'}
              </Button>
            </Box>
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

export default HealthProfileSettings;
