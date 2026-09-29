/**
 * A gym's optional GPS position (E3.5): the saved value with Clear, two manual
 * inputs with live validation, and, where the browser can, "Use my location".
 *
 * Privacy rules this component keeps:
 * - Location is optional and never taken silently. "Use my location" asks the
 *   browser once, from the click, through `useGeolocationOnce` (never
 *   `watchPosition`); a one-line explanation sits next to the button, so it is
 *   read before the browser prompt appears.
 * - A position the browser returns only fills the inputs; nothing is saved
 *   until the user presses the save button.
 * - The button is hidden where it cannot work (no `navigator.geolocation`, or
 *   not a secure context); the manual inputs always work, including after a
 *   denied prompt.
 * - The accuracy is shown and sent only so the API can echo it; it is never
 *   stored.
 *
 * The component does not call the API itself: the host passes `onSave` and
 * `onClear` (the gym page saves through `PUT/DELETE /gyms/:id/location`; the
 * new-gym form keeps the pair in its own state until the gym is created).
 */
import { useId, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  FormHelperText,
  Link,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { MyLocation as MyLocationIcon } from '@mui/icons-material';
import { useGeolocationOnce } from '../../hooks/useGeolocationOnce';
import { gymErrorMessage, LOCATION_ACCURACY_MAX, type GymLocationInput } from '../../services/gyms';
import {
  APPROXIMATE_ACCURACY_M,
  coordinateError,
  formatAccuracy,
  formatCoordinate,
  LOCATION_HELPER_TEXT,
  LOCATION_PROMPT_EXPLANATION,
  openStreetMapUrl,
  splitCoordinatePair,
} from './gymLocation';

export interface GymLocationFieldProps {
  /** The saved position (both or neither). */
  latitude: number | null;
  longitude: number | null;
  /** Rejects with the API error to show it. */
  onSave: (input: GymLocationInput) => Promise<void>;
  /** Rejects with the API error to show it. */
  onClear: () => Promise<void>;
  /** Without `gyms:write` only the saved value and the map link are shown. */
  canWrite?: boolean;
  saveLabel?: string;
  /** Prefix of the saved line: "Saved: 10.00123, -84.12345". */
  savedPrefix?: string;
  emptyLabel?: string;
}

interface Fix {
  latitude: string;
  longitude: string;
  accuracy: number;
}

export function GymLocationField({
  latitude,
  longitude,
  onSave,
  onClear,
  canWrite = true,
  saveLabel = 'Save location',
  savedPrefix = 'Saved',
  emptyLabel = 'No location saved',
}: GymLocationFieldProps) {
  const baseId = useId();
  const helperId = `${baseId}-helper`;
  const geo = useGeolocationOnce();
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<GymLocationInput | null>(null);

  const saved = latitude !== null && longitude !== null;
  const latFormat = coordinateError(lat, 'latitude');
  const lngFormat = coordinateError(lng, 'longitude');
  const latBlank = lat.trim() === '';
  const lngBlank = lng.trim() === '';
  const latError = latFormat ?? (attempted && latBlank && !lngBlank ? 'Enter a latitude too.' : null);
  const lngError = lngFormat ?? (attempted && lngBlank && !latBlank ? 'Enter a longitude too.' : null);
  const bothBlank = latBlank && lngBlank;
  const invalid = Boolean(latFormat || lngFormat || latBlank || lngBlank);
  // The accuracy only describes the browser's fix while the inputs still hold it.
  const liveFix = fix && fix.latitude === lat && fix.longitude === lng ? fix : null;
  const showButton = canWrite && geo.support === 'supported';

  const edit = (axis: 'latitude' | 'longitude') => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const pair = splitCoordinatePair(value);
    if (pair) {
      setLat(pair.latitude);
      setLng(pair.longitude);
    } else if (axis === 'latitude') setLat(value);
    else setLng(value);
    setError(null);
  };

  // Enter in a coordinate input must not submit a surrounding gym form.
  const swallowEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  const locate = async () => {
    setError(null);
    try {
      const position = await geo.request();
      const next = {
        latitude: formatCoordinate(position.latitude),
        longitude: formatCoordinate(position.longitude),
        accuracy: position.accuracy,
      };
      setLat(next.latitude);
      setLng(next.longitude);
      setFix(next);
    } catch {
      // The hook holds the mapped message; the manual inputs stay usable.
    }
  };

  const save = async () => {
    setAttempted(true);
    if (invalid || busy) return;
    const input: GymLocationInput = { latitude: Number(lat.trim()), longitude: Number(lng.trim()) };
    if (liveFix && Number.isFinite(liveFix.accuracy) && liveFix.accuracy >= 0 && liveFix.accuracy <= LOCATION_ACCURACY_MAX) {
      input.accuracyMeters = Math.round(liveFix.accuracy);
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
      setLat('');
      setLng('');
      setFix(null);
      setAttempted(false);
      geo.reset();
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not save the location'));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!saved || busy) return;
    const previous = { latitude: latitude!, longitude: longitude! };
    setBusy(true);
    setError(null);
    try {
      await onClear();
      setUndo(previous);
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not clear the location'));
    } finally {
      setBusy(false);
    }
  };

  const undoClear = async () => {
    const previous = undo;
    setUndo(null);
    if (!previous) return;
    setBusy(true);
    try {
      await onSave(previous);
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not restore the location'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ flexGrow: 1, overflowWrap: 'anywhere' }} data-testid="gym-location-status">
          {saved ? `${savedPrefix}: ${formatCoordinate(latitude!)}, ${formatCoordinate(longitude!)}` : emptyLabel}
        </Typography>
        {saved && (
          <Link href={openStreetMapUrl(latitude!, longitude!)} target="_blank" rel="noopener noreferrer">
            Open in maps
          </Link>
        )}
        {saved && canWrite && (
          <Button type="button" color="error" onClick={() => void clear()} disabled={busy}>
            Clear
          </Button>
        )}
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {canWrite && (
        <>
          {showButton && (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {LOCATION_PROMPT_EXPLANATION}
              </Typography>
              <Button
                type="button"
                variant="outlined"
                startIcon={<MyLocationIcon />}
                onClick={() => void locate()}
                disabled={geo.state === 'asking' || busy}
              >
                {geo.state === 'asking' ? 'Locating...' : 'Use my location'}
              </Button>
            </Box>
          )}
          {geo.error && (
            <Alert severity="warning" role="alert">
              {geo.error.message}
            </Alert>
          )}
          {liveFix && (
            <Typography variant="body2" color="text.secondary" role="status">
              Filled from your device, accuracy {formatAccuracy(liveFix.accuracy)}. Not saved yet.
            </Typography>
          )}
          {liveFix && liveFix.accuracy > APPROXIMATE_ACCURACY_M && (
            <Alert severity="warning">This position is very approximate.</Alert>
          )}

          <Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Latitude"
                value={lat}
                onChange={edit('latitude')}
                onKeyDown={swallowEnter}
                fullWidth
                error={Boolean(latError)}
                helperText={latError ?? '-90 to 90'}
                slotProps={{ htmlInput: { inputMode: 'decimal', 'aria-describedby': helperId, autoComplete: 'off' } }}
              />
              <TextField
                label="Longitude"
                value={lng}
                onChange={edit('longitude')}
                onKeyDown={swallowEnter}
                fullWidth
                error={Boolean(lngError)}
                helperText={lngError ?? '-180 to 180'}
                slotProps={{ htmlInput: { inputMode: 'decimal', 'aria-describedby': helperId, autoComplete: 'off' } }}
              />
            </Stack>
            <FormHelperText id={helperId}>{LOCATION_HELPER_TEXT}</FormHelperText>
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="button"
              variant="contained"
              onClick={() => void save()}
              disabled={busy || bothBlank || Boolean(latFormat || lngFormat)}
            >
              {saveLabel}
            </Button>
          </Box>
        </>
      )}

      <Snackbar
        open={undo !== null}
        autoHideDuration={6000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setUndo(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          variant="filled"
          sx={{ width: '100%' }}
          action={
            <Button color="inherit" size="small" onClick={() => void undoClear()}>
              Undo
            </Button>
          }
        >
          Location cleared.
        </Alert>
      </Snackbar>
    </Stack>
  );
}

export default GymLocationField;
