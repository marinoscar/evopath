/**
 * `GymLocationField` (E3.5): the saved value with Clear (and Undo), manual
 * latitude/longitude with live validation, and "Use my location", shown only
 * with `navigator.geolocation` in a secure context, which fills the inputs
 * without saving anything until "Save location".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../utils/test-utils';
import type { MapPoint } from '../../../components/gyms/GymMapPicker';
import { GymLocationField } from '../../../components/gyms/GymLocationField';
import { LOCATION_HELPER_TEXT, LOCATION_PROMPT_EXPLANATION } from '../../../components/gyms/gymLocation';
import type { GymLocationInput } from '../../../services/gyms';

// Leaflet stays out of these tests: a stub picker exposes a button that picks.
vi.mock('../../../components/gyms/GymMapPicker', () => ({
  default: ({
    open,
    initial,
    onPick,
    onClose,
  }: {
    open: boolean;
    initial: MapPoint | null;
    onPick: (p: MapPoint) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="picker-stub" data-initial={initial ? `${initial.latitude},${initial.longitude}` : ''}>
        <button onClick={() => onPick({ latitude: 9.93401234, longitude: -84.08 })}>Stub pick</button>
        <button onClick={onClose}>Stub close</button>
      </div>
    ) : null,
}));

const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

function installPermissionState(state: string) {
  const status = { state, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(() => Promise.resolve(status)) },
  });
}

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

function installGeolocation(behaviour: (success: Success, failure: Failure) => void, secure = true) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  const getCurrentPosition = vi.fn((success: Success, failure: Failure) => behaviour(success, failure));
  const watchPosition = vi.fn();
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition, watchPosition, clearWatch: vi.fn() },
  });
  return { getCurrentPosition, watchPosition };
}

function removeGeolocation() {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
  delete (navigator as unknown as Record<string, unknown>).geolocation;
}

const fixAt = (latitude: number, longitude: number, accuracy: number) =>
  ({ coords: { latitude, longitude, accuracy }, timestamp: 0 }) as unknown as GeolocationPosition;
const errorCode = (code: number) => ({ code, message: '' }) as GeolocationPositionError;

afterEach(() => {
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as unknown as Record<string, unknown>).permissions;
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else delete (window as unknown as Record<string, unknown>).isSecureContext;
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  else delete (navigator as unknown as Record<string, unknown>).geolocation;
});

/** A host that stores what is saved, like the gym page does through the API. */
function Harness({
  initial = null,
  onSave,
  onClear,
  canWrite,
}: {
  initial?: { latitude: number; longitude: number } | null;
  onSave?: (input: GymLocationInput) => void;
  onClear?: () => void;
  canWrite?: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  return (
    <GymLocationField
      latitude={saved?.latitude ?? null}
      longitude={saved?.longitude ?? null}
      canWrite={canWrite}
      onSave={async (input) => {
        onSave?.(input);
        setSaved({ latitude: input.latitude, longitude: input.longitude });
      }}
      onClear={async () => {
        onClear?.();
        setSaved(null);
      }}
    />
  );
}

const latInput = () => screen.getByRole('textbox', { name: 'Latitude' });
const lngInput = () => screen.getByRole('textbox', { name: 'Longitude' });

describe('GymLocationField', () => {
  it('shows "No location saved", the helper text, and saves typed coordinates', async () => {
    removeGeolocation();
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);

    expect(screen.getByText('No location saved')).toBeInTheDocument();
    expect(screen.getByText(LOCATION_HELPER_TEXT)).toBeInTheDocument();
    await user.type(latInput(), '9.93400');
    await user.type(lngInput(), '-84.08000');
    await user.click(screen.getByRole('button', { name: 'Save location' }));

    expect(onSave).toHaveBeenCalledWith({ latitude: 9.934, longitude: -84.08 });
    expect(await screen.findByText('Saved: 9.93400, -84.08000')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open in maps' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/?mlat=9.93400&mlon=-84.08000#map=17/9.93400/-84.08000',
    );
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(latInput()).toHaveValue('');
  });

  it('validates live: range, text, a decimal comma, and a missing half', async () => {
    removeGeolocation();
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);

    await user.type(latInput(), '91');
    expect(screen.getByText('Latitude is between -90 and 90.')).toBeInTheDocument();
    await user.clear(latInput());
    await user.type(latInput(), 'abc');
    expect(screen.getByText('Enter a number, for example 9.934.')).toBeInTheDocument();
    await user.type(lngInput(), '-181');
    expect(screen.getByText('Longitude is between -180 and 180.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled();

    await user.clear(latInput());
    await user.clear(lngInput());
    await user.type(latInput(), '10,5');
    expect(screen.getByText(/Use a dot for decimals/)).toBeInTheDocument();

    await user.clear(latInput());
    await user.type(latInput(), '10.5');
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(screen.getByText('Enter a longitude too.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('splits a pasted "lat, lng" pair into both fields', async () => {
    removeGeolocation();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(latInput());
    await user.paste('10.0012, -84.1234');
    expect(latInput()).toHaveValue('10.0012');
    expect(lngInput()).toHaveValue('-84.1234');
  });

  it('hides "Use my location" without navigator.geolocation', () => {
    removeGeolocation();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();
    expect(latInput()).toBeEnabled();
  });

  it('hides "Use my location" outside a secure context', () => {
    installGeolocation(() => undefined, false);
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();
    expect(latInput()).toBeEnabled();
  });

  it('fills the inputs with the accuracy and saves nothing until "Save location"', async () => {
    const geo = installGeolocation((success) => success(fixAt(10.001234, -84.123456, 25.4)));
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);

    expect(screen.getByText(LOCATION_PROMPT_EXPLANATION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(await screen.findByText(/accuracy about 25 m/)).toBeInTheDocument();
    expect(latInput()).toHaveValue('10.00123');
    expect(lngInput()).toHaveValue('-84.12346');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('No location saved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave).toHaveBeenCalledWith({ latitude: 10.00123, longitude: -84.12346, accuracyMeters: 25 });
    expect(await screen.findByText('Saved: 10.00123, -84.12346')).toBeInTheDocument();
  });

  it('warns about a very approximate position but still allows saving', async () => {
    installGeolocation((success) => success(fixAt(10, -84, 12000)));
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(await screen.findByText('This position is very approximate.')).toBeInTheDocument();
    expect(screen.getByText(/accuracy about 12.0 km/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave).toHaveBeenCalledWith({ latitude: 10, longitude: -84, accuracyMeters: 12000 });
  });

  it.each([
    [1, 'Location permission was denied. You can type coordinates instead.'],
    [2, 'Your device could not determine a position.'],
    [3, 'Timed out. Try again or type coordinates.'],
  ])('error code %i shows its message and leaves manual entry working', async (code, message) => {
    installGeolocation((_success, failure) => failure(errorCode(code)));
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(await screen.findByText(message)).toBeInTheDocument();

    await user.type(latInput(), '9.934');
    await user.type(lngInput(), '-84.08');
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave).toHaveBeenCalledWith({ latitude: 9.934, longitude: -84.08 });
  });

  it('calls getCurrentPosition exactly once per click', async () => {
    const geo = installGeolocation((success) => success(fixAt(1, 2, 3)));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    await screen.findByText(/accuracy about 3 m/);
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2));
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it('clears a saved location at once and restores it with Undo', async () => {
    removeGeolocation();
    const onSave = vi.fn();
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ latitude: 10.00123, longitude: -84.12345 }} onSave={onSave} onClear={onClear} />);

    expect(screen.getByText('Saved: 10.00123, -84.12345')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('No location saved')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in maps' })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(onSave).toHaveBeenCalledWith({ latitude: 10.00123, longitude: -84.12345 });
    expect(await screen.findByText('Saved: 10.00123, -84.12345')).toBeInTheDocument();
  });

  it('shows only the saved value and the map link without write access', () => {
    installGeolocation(() => undefined);
    render(<Harness initial={{ latitude: 1, longitude: 2 }} canWrite={false} />);
    expect(screen.getByText('Saved: 1.00000, 2.00000')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in maps' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Latitude' })).toBeNull();
  });
});

describe('GymLocationField blocked state and map picker (issue #121)', () => {
  it('shows the blocked Alert after a PERMISSION_DENIED failure and Try again asks once more', async () => {
    const geo = installGeolocation((_success, failure) => failure(errorCode(1)));
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(await screen.findByText('Location is blocked for this site')).toBeInTheDocument();
    expect(screen.getByText('Location permission was denied. You can type coordinates instead.')).toBeInTheDocument();
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2));
    expect(geo.watchPosition).not.toHaveBeenCalled();
    // "Use my location" stays available.
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeInTheDocument();
  });

  it('shows the blocked Alert up front when the permission query reports denied', async () => {
    const geo = installGeolocation(() => undefined);
    installPermissionState('denied');
    render(<Harness />);

    expect(await screen.findByText('Location is blocked for this site')).toBeInTheDocument();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('does not show the blocked Alert for a non-denied failure', async () => {
    installGeolocation((_success, failure) => failure(errorCode(2)));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(await screen.findByText('Your device could not determine a position.')).toBeInTheDocument();
    expect(screen.queryByText('Location is blocked for this site')).toBeNull();
  });

  it('offers Pick on map when geolocation is unsupported, and not without write access', () => {
    removeGeolocation();
    const { unmount } = render(<Harness />);
    expect(screen.getByRole('button', { name: 'Pick on map' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();
    unmount();

    render(<Harness canWrite={false} />);
    expect(screen.queryByRole('button', { name: 'Pick on map' })).toBeNull();
  });

  it('offers Pick on map outside a secure context', () => {
    installGeolocation(() => undefined, false);
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Pick on map' })).toBeInTheDocument();
  });

  it('fills the inputs from a picked pin, saves nothing, and sends no accuracy on save', async () => {
    removeGeolocation();
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    await user.click(await screen.findByRole('button', { name: 'Stub pick' }));

    expect(latInput()).toHaveValue('9.93401');
    expect(lngInput()).toHaveValue('-84.08000');
    expect(screen.getByText('Filled from the map. Not saved yet.')).toBeInTheDocument();
    expect(screen.getByText('No location saved')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ latitude: 9.93401, longitude: -84.08 });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('accuracyMeters');
  });

  it('drops the map status line once the user edits the inputs', async () => {
    removeGeolocation();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    await user.click(await screen.findByRole('button', { name: 'Stub pick' }));
    expect(screen.getByText('Filled from the map. Not saved yet.')).toBeInTheDocument();
    await user.type(latInput(), '1');
    expect(screen.queryByText('Filled from the map. Not saved yet.')).toBeNull();
  });

  it('a pick after a device fix replaces the fix, so no accuracy is sent', async () => {
    installGeolocation((success) => success(fixAt(10, -84, 25)));
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    await screen.findByText(/accuracy about 25 m/);

    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    await user.click(await screen.findByRole('button', { name: 'Stub pick' }));
    expect(screen.queryByText(/accuracy about/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('accuracyMeters');
  });

  it('starts the map at the typed position, else the saved one, else nothing', async () => {
    removeGeolocation();
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    expect((await screen.findByTestId('picker-stub')).getAttribute('data-initial')).toBe('');
    unmount();

    const second = render(<Harness initial={{ latitude: 1, longitude: 2 }} />);
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    expect((await screen.findByTestId('picker-stub')).getAttribute('data-initial')).toBe('1,2');
    await user.click(screen.getByRole('button', { name: 'Stub close' }));
    await waitFor(() => expect(screen.queryByTestId('picker-stub')).toBeNull());
    second.unmount();

    render(<Harness initial={{ latitude: 1, longitude: 2 }} />);
    await user.type(latInput(), '5.5');
    await user.type(lngInput(), '6.5');
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    expect((await screen.findByTestId('picker-stub')).getAttribute('data-initial')).toBe('5.5,6.5');
  });
});
