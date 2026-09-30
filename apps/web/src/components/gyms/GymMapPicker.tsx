/**
 * "Pick the gym on the map" (issue #121): a dialog with an OpenStreetMap map
 * where a tap drops a draggable pin; "Use this pin" hands the position back.
 *
 * Why it exists: "Use my location" cannot work once the browser remembers a
 * block for the site (it never asks again), and the gym is often not where
 * the user is standing anyway. Picking on a map needs no permission at all.
 *
 * Privacy:
 * - The map tiles come straight from OpenStreetMap (`OSM_TILE_URL`), so OSM
 *   sees the tile requests for the area on screen. The pin's coordinates are
 *   never sent anywhere; they are handed to the caller, which only fills the
 *   form, and nothing is saved until the user presses save.
 * - With no starting point, the map opens on the device's position only when
 *   the browser already granted geolocation (no prompt can appear), asked
 *   once with `getCurrentPosition` through `useGeolocationOnce`, and it only
 *   centres the view: no pin is dropped from it.
 *
 * Implementation notes:
 * - Plain Leaflet behind a ref, not react-leaflet. This module is loaded with
 *   `React.lazy` by `GymLocationField`, so Leaflet stays out of the main bundle.
 * - The pin is an `L.divIcon` with an inline SVG: Leaflet's default image icon
 *   resolves its PNG paths at runtime, which a bundler breaks.
 * - The map lives in the dialog's content, so it is created when the dialog
 *   opens and removed (`map.remove()`) when the content unmounts after close.
 *   `invalidateSize()` runs after the enter transition (and on resize) so the
 *   tiles fill a container that was still animating when the map measured it.
 * - Longitudes are wrapped into [-180, 180] (`latlng.wrap()`) and latitudes
 *   clamped to [-90, 90]; the API rejects anything else.
 * - Keyboard: the map container is focusable with Leaflet's arrow-key pan and
 *   +/- zoom; Enter or Space drops the pin at the centre of the view.
 */
import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useGeolocationOnce } from '../../hooks/useGeolocationOnce';
import { formatCoordinate, OSM_ATTRIBUTION, OSM_TILE_MAX_ZOOM, OSM_TILE_URL } from './gymLocation';
import { useCompactDialog } from './useCompactDialog';

export interface MapPoint {
  latitude: number;
  longitude: number;
}

export interface GymMapPickerProps {
  open: boolean;
  /** Where to start, with a pin; null opens without one. */
  initial: MapPoint | null;
  onClose: () => void;
  onPick: (point: MapPoint) => void;
}

const PIN_ZOOM = 16;
const DEVICE_ZOOM = 15;
const WORLD_CENTER: L.LatLngTuple = [20, 0];
const WORLD_ZOOM = 2;
const PIN_CLASS = 'gym-map-pin';

const MAP_LABEL =
  'Map. Use the arrow keys to pan and plus or minus to zoom. Press Enter to drop the pin at the centre.';

const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="32" height="40" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" stroke="#fff" stroke-width="2" d="M16 1C8.3 1 2 7.2 2 14.9 2 25.4 16 39 16 39s14-13.6 14-24.1C30 7.2 23.7 1 16 1z"/>' +
  '<circle cx="16" cy="15" r="5" fill="#fff"/>' +
  '</svg>';

function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: PIN_CLASS,
    html: PIN_SVG,
    iconSize: [32, 40],
    iconAnchor: [16, 40],
  });
}

/** Wrap the longitude into [-180, 180] and clamp the latitude to [-90, 90]. */
function normalize(latlng: L.LatLng): MapPoint {
  const wrapped = latlng.wrap();
  return {
    latitude: Math.max(-90, Math.min(90, wrapped.lat)),
    longitude: Math.max(-180, Math.min(180, wrapped.lng)),
  };
}

interface MapCanvasProps {
  initial: MapPoint | null;
  label: string;
  mapRef: MutableRefObject<L.Map | null>;
  onPin: (point: MapPoint) => void;
  /** The device's position to centre on, if it arrives before a pin exists. */
  deviceCentre: MapPoint | null;
}

function MapCanvas({ initial, label, mapRef, onPin, deviceCentre }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Leaflet's handlers are bound once; always call the latest callback.
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const map = L.map(el, {
      center: initial ? [initial.latitude, initial.longitude] : WORLD_CENTER,
      zoom: initial ? PIN_ZOOM : WORLD_ZOOM,
      worldCopyJump: true,
      keyboard: true,
    });
    mapRef.current = map;
    L.tileLayer(OSM_TILE_URL, { maxZoom: OSM_TILE_MAX_ZOOM, attribution: OSM_ATTRIBUTION }).addTo(map);
    map.getContainer().setAttribute('aria-label', label);

    const place = (latlng: L.LatLng) => {
      if (markerRef.current) {
        markerRef.current.setLatLng(latlng);
      } else {
        const marker = L.marker(latlng, {
          icon: pinIcon(),
          draggable: true,
          keyboard: true,
          title: 'Gym pin',
          alt: 'Gym pin',
        }).addTo(map);
        marker.on('dragend', () => onPinRef.current(normalize(marker.getLatLng())));
        markerRef.current = marker;
      }
      onPinRef.current(normalize(latlng));
    };

    if (initial) place(L.latLng(initial.latitude, initial.longitude));
    map.on('click', (event: L.LeafletMouseEvent) => place(event.latlng));

    // Enter / Space on the focused map drops the pin at the centre.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== map.getContainer()) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        place(map.getCenter());
      }
    };
    map.getContainer().addEventListener('keydown', onKeyDown);

    // The fullscreen dialog resizes with the viewport (rotation, keyboard).
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      map.getContainer().removeEventListener('keydown', onKeyDown);
      map.remove();
      markerRef.current = null;
      mapRef.current = null;
    };
    // Created once per open; `initial` is the starting point only.
  }, []);

  // Centre on the device only while the user has not dropped a pin.
  useEffect(() => {
    if (!deviceCentre || markerRef.current || !mapRef.current) return;
    mapRef.current.setView([deviceCentre.latitude, deviceCentre.longitude], DEVICE_ZOOM);
  }, [deviceCentre, mapRef]);

  return (
    <Box
      ref={containerRef}
      data-testid="gym-map"
      sx={{
        width: '100%',
        height: '100%',
        minHeight: 240,
        borderRadius: 1,
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        [`& .${PIN_CLASS}`]: {
          color: 'primary.main',
          background: 'none',
          border: 'none',
          filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
        },
      }}
    />
  );
}

interface PickerBodyProps extends Omit<GymMapPickerProps, 'open'> {
  titleId: string;
  mapRef: MutableRefObject<L.Map | null>;
}

/** Mounted with the dialog's content, so its state starts fresh on each open. */
function PickerBody({ initial, onClose, onPick, titleId, mapRef }: PickerBodyProps) {
  const fullScreen = useCompactDialog();
  const [pin, setPin] = useState<MapPoint | null>(initial);
  const [deviceCentre, setDeviceCentre] = useState<MapPoint | null>(null);
  const geo = useGeolocationOnce();
  const askedDevice = useRef(false);
  const { permission, request } = geo;

  // Only where the browser already granted geolocation (so nothing prompts),
  // and only without a starting point: one fix to centre the view.
  useEffect(() => {
    if (initial || askedDevice.current || permission !== 'granted') return;
    askedDevice.current = true;
    request()
      .then((fix) => setDeviceCentre({ latitude: fix.latitude, longitude: fix.longitude }))
      .catch(() => {
        // Stay on the world view.
      });
  }, [initial, permission, request]);

  return (
    <>
      <DialogTitle id={titleId}>Pick the gym on the map</DialogTitle>
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          ...(fullScreen ? { flex: 1, minHeight: 0 } : {}),
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Tap the map to drop a pin. Drag it to adjust.
        </Typography>
        <Box sx={fullScreen ? { flex: 1, minHeight: 0 } : { height: 'min(60vh, 480px)' }}>
          <MapCanvas
            initial={initial}
            label={MAP_LABEL}
            mapRef={mapRef}
            onPin={setPin}
            deviceCentre={deviceCentre}
          />
        </Box>
        <Typography variant="body2" role="status" data-testid="gym-map-readout" sx={{ overflowWrap: 'anywhere' }}>
          {pin ? `Pin: ${formatCoordinate(pin.latitude)}, ${formatCoordinate(pin.longitude)}` : 'No pin yet.'}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="contained" disabled={!pin} onClick={() => pin && onPick(pin)}>
          Use this pin
        </Button>
      </DialogActions>
    </>
  );
}

export function GymMapPicker({ open, initial, onClose, onPick }: GymMapPickerProps) {
  const fullScreen = useCompactDialog();
  const titleId = useId();
  const mapRef = useRef<L.Map | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
      slotProps={{ transition: { onEntered: () => mapRef.current?.invalidateSize() } }}
    >
      <PickerBody initial={initial} onClose={onClose} onPick={onPick} titleId={titleId} mapRef={mapRef} />
    </Dialog>
  );
}

export default GymMapPicker;
