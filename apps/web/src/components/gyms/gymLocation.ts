/**
 * Parsing, validation and formatting for a gym's optional position (E3.5).
 * The bounds mirror the API's Zod schema so the field can explain a problem
 * before the round trip; the API decides.
 */
import { LATITUDE_MAX, LATITUDE_MIN, LONGITUDE_MAX, LONGITUDE_MIN } from '../../services/gyms';

/** A plain decimal with a dot: `10`, `-84.12345`, `+9.9`, `.5`. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Accuracy worse than this (metres) is flagged as very approximate. */
export const APPROXIMATE_ACCURACY_M = 5000;

export const LOCATION_HELPER_TEXT =
  'Optional. Used only to recognize this gym later, never tracked in the background.';
export const LOCATION_PROMPT_EXPLANATION =
  'Your browser asks once to share your position; it only fills these fields.';

export const DECIMAL_COMMA_HINT = 'Use a dot for decimals, for example 10.5 (not 10,5).';

/**
 * A pasted pair such as `10.0012, -84.1234`, split into both fields. A bare
 * `10,5` is not a pair (no dot on either side and no space after the comma):
 * that is a locale decimal comma, which the field explains instead.
 */
export function splitCoordinatePair(value: string): { latitude: string; longitude: string } | null {
  const match = value.match(/^\s*([^,\s]+)\s*,(\s*)([^,\s]+)\s*$/);
  if (!match) return null;
  const [, lat, space, lng] = match;
  if (!DECIMAL.test(lat!) || !DECIMAL.test(lng!)) return null;
  if (space === '' && !lat!.includes('.') && !lng!.includes('.')) return null;
  return { latitude: lat!, longitude: lng! };
}

/** Why a coordinate string is not acceptable, or null (blank is acceptable here). */
export function coordinateError(value: string, axis: 'latitude' | 'longitude'): string | null {
  const text = value.trim();
  if (text === '') return null;
  if (!DECIMAL.test(text)) {
    return /^[+-]?\d+,\d+$/.test(text) ? DECIMAL_COMMA_HINT : 'Enter a number, for example 9.934.';
  }
  const n = Number(text);
  const [min, max] = axis === 'latitude' ? [LATITUDE_MIN, LATITUDE_MAX] : [LONGITUDE_MIN, LONGITUDE_MAX];
  if (!Number.isFinite(n) || n < min || n > max) {
    return axis === 'latitude' ? 'Latitude is between -90 and 90.' : 'Longitude is between -180 and 180.';
  }
  return null;
}

/** Five decimals, about 1 m: what the API stores. */
export function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

/** "about 25 m" / "about 5.2 km". */
export function formatAccuracy(meters: number): string {
  if (meters < 1000) return `about ${Math.max(1, Math.round(meters))} m`;
  return `about ${(meters / 1000).toFixed(1)} km`;
}

/** A plain link to the position on OpenStreetMap: no embed, no third-party script. */
export function openStreetMapUrl(latitude: number, longitude: number): string {
  const lat = formatCoordinate(latitude);
  const lon = formatCoordinate(longitude);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}
