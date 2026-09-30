/**
 * `GymMapPicker` (issue #121): the Leaflet dialog. Leaflet is mocked at the
 * module boundary (jsdom cannot lay out a map); the fake records what the
 * component asked for and lets a test fire the map's `click` and the marker's
 * `dragend`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '../../utils/test-utils';
import { GymMapPicker } from '../../../components/gyms/GymMapPicker';
import { OSM_ATTRIBUTION, OSM_TILE_MAX_ZOOM, OSM_TILE_URL } from '../../../components/gyms/gymLocation';

interface FakeLatLng {
  lat: number;
  lng: number;
  wrap: () => FakeLatLng;
}

const leaflet = vi.hoisted(() => {
  const state = {
    maps: [] as unknown[],
    markers: [] as unknown[],
    tileLayers: [] as unknown[],
    divIcons: [] as unknown[],
  };
  const latLng = (lat: number, lng: number): FakeLatLng => ({
    lat,
    lng,
    // Leaflet wraps the longitude only; it does not clamp the latitude.
    wrap: () => latLng(lat, lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180),
  });
  return { state, latLng };
});

vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet', () => {
  const { state, latLng } = leaflet;
  const api = {
    latLng,
    map: vi.fn((el: HTMLElement, options: Record<string, unknown>) => {
      const handlers: Record<string, (e: unknown) => void> = {};
      const map = {
        options,
        handlers,
        on: vi.fn((type: string, fn: (e: unknown) => void) => {
          handlers[type] = fn;
        }),
        getContainer: () => el,
        getCenter: () => latLng(1, 2),
        setView: vi.fn(),
        invalidateSize: vi.fn(),
        remove: vi.fn(),
      };
      state.maps.push(map);
      return map;
    }),
    tileLayer: vi.fn((url: string, options: Record<string, unknown>) => {
      const layer = { url, options, addTo: vi.fn(() => layer) };
      state.tileLayers.push(layer);
      return layer;
    }),
    divIcon: vi.fn((options: Record<string, unknown>) => {
      state.divIcons.push(options);
      return options;
    }),
    marker: vi.fn((pos: FakeLatLng, options: Record<string, unknown>) => {
      const handlers: Record<string, () => void> = {};
      const marker = {
        options,
        handlers,
        pos,
        addTo: vi.fn(() => marker),
        setLatLng: vi.fn((p: FakeLatLng) => {
          marker.pos = p;
        }),
        getLatLng: () => marker.pos,
        on: vi.fn((type: string, fn: () => void) => {
          handlers[type] = fn;
        }),
      };
      state.markers.push(marker);
      return marker;
    }),
  };
  return { default: api, ...api };
});

interface FakeMap {
  options: { center: number[]; zoom: number };
  handlers: Record<string, (e: unknown) => void>;
  setView: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}
interface FakeMarker {
  handlers: Record<string, () => void>;
  pos: FakeLatLng;
  options: { draggable: boolean };
}
const lastMap = () => leaflet.state.maps.at(-1) as FakeMap;
const lastMarker = () => leaflet.state.markers.at(-1) as FakeMarker;

const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

beforeEach(() => {
  leaflet.state.maps.length = 0;
  leaflet.state.markers.length = 0;
  leaflet.state.tileLayers.length = 0;
  leaflet.state.divIcons.length = 0;
});

afterEach(() => {
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as unknown as Record<string, unknown>).permissions;
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  else delete (navigator as unknown as Record<string, unknown>).geolocation;
});

function clickMap(lat: number, lng: number) {
  const map = lastMap();
  // Wrapped in act by the caller.
  map.handlers.click!({ latlng: leaflet.latLng(lat, lng) });
}


describe('GymMapPicker', () => {
  it('uses the OpenStreetMap tiles with attribution', async () => {
    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('Pick the gym on the map');
    const layer = leaflet.state.tileLayers[0] as { url: string; options: Record<string, unknown> };
    expect(layer.url).toBe(OSM_TILE_URL);
    expect(layer.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(layer.options).toEqual({ maxZoom: OSM_TILE_MAX_ZOOM, attribution: OSM_ATTRIBUTION });
    expect(OSM_ATTRIBUTION).toMatch(/OpenStreetMap/);
  });

  it('opens on the initial point at zoom 16 with a pin, and hands it back', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<GymMapPicker open initial={{ latitude: 9.934, longitude: -84.08 }} onClose={vi.fn()} onPick={onPick} />);

    await screen.findByText('Pick the gym on the map');
    expect(lastMap().options.center).toEqual([9.934, -84.08]);
    expect(lastMap().options.zoom).toBe(16);
    expect(leaflet.state.markers).toHaveLength(1);
    expect(lastMarker().options.draggable).toBe(true);
    expect(screen.getByTestId('gym-map-readout')).toHaveTextContent('Pin: 9.93400, -84.08000');

    const use = screen.getByRole('button', { name: 'Use this pin' });
    expect(use).toBeEnabled();
    await user.click(use);
    expect(onPick).toHaveBeenCalledWith({ latitude: 9.934, longitude: -84.08 });
  });

  it('opens on the world view with the button disabled until the map is clicked', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={onPick} />);

    await screen.findByText('Pick the gym on the map');
    expect(lastMap().options.center).toEqual([20, 0]);
    expect(lastMap().options.zoom).toBe(2);
    expect(leaflet.state.markers).toHaveLength(0);
    expect(screen.getByText('No pin yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this pin' })).toBeDisabled();

    act(() => clickMap(10.5, -84.25));
    expect(leaflet.state.markers).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Use this pin' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use this pin' }));
    expect(onPick).toHaveBeenCalledWith({ latitude: 10.5, longitude: -84.25 });
  });

  it('moves the one pin on a second click instead of adding another', async () => {
    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('Pick the gym on the map');
    act(() => clickMap(1, 1));
    act(() => clickMap(2, 3));
    expect(leaflet.state.markers).toHaveLength(1);
    expect(screen.getByTestId('gym-map-readout')).toHaveTextContent('Pin: 2.00000, 3.00000');
  });

  it('follows the pin when it is dragged', async () => {
    render(<GymMapPicker open initial={{ latitude: 1, longitude: 1 }} onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('Pick the gym on the map');
    lastMarker().pos = leaflet.latLng(7, 8);
    act(() => lastMarker().handlers.dragend!());
    expect(screen.getByTestId('gym-map-readout')).toHaveTextContent('Pin: 7.00000, 8.00000');
  });

  it('wraps the longitude and clamps the latitude', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={onPick} />);
    await screen.findByText('Pick the gym on the map');

    act(() => clickMap(95, 190));
    await user.click(screen.getByRole('button', { name: 'Use this pin' }));
    expect(onPick).toHaveBeenLastCalledWith({ latitude: 90, longitude: -170 });

    act(() => clickMap(-100, -190));
    await user.click(screen.getByRole('button', { name: 'Use this pin' }));
    expect(onPick).toHaveBeenLastCalledWith({ latitude: -90, longitude: 170 });
  });

  it('Cancel closes without picking', async () => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<GymMapPicker open initial={{ latitude: 1, longitude: 2 }} onClose={onClose} onPick={onPick} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('removes the map when the dialog closes', async () => {
    const { rerender } = render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('Pick the gym on the map');
    const map = lastMap();
    expect(map.remove).not.toHaveBeenCalled();

    rerender(<GymMapPicker open={false} initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(map.remove).toHaveBeenCalledTimes(1));
  });

  it('removes the map on unmount', async () => {
    const { unmount } = render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('Pick the gym on the map');
    const map = lastMap();
    unmount();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it('centres on the device, without a pin, only when geolocation is already granted', async () => {
    const getCurrentPosition = vi.fn((success: (p: GeolocationPosition) => void) =>
      success({ coords: { latitude: 3, longitude: 4, accuracy: 10 }, timestamp: 0 } as unknown as GeolocationPosition),
    );
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    });
    const status = { state: 'granted', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(() => Promise.resolve(status)) },
    });

    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(lastMap().setView).toHaveBeenCalledWith([3, 4], 15));
    expect(leaflet.state.markers).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Use this pin' })).toBeDisabled();
  });

  it('does not ask the device when the permission is only prompt', async () => {
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    });
    const status = { state: 'prompt', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const query = vi.fn(() => Promise.resolve(status));
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });

    render(<GymMapPicker open initial={null} onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(status.addEventListener).toHaveBeenCalled());
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
});
