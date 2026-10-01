/**
 * "Tidal Teal" colour tokens — the one token set every MUI colour scheme in
 * `theme/` is built from.
 *
 * The values are Candidate A of `docs/design/color-scheme-options.md` (§4,
 * "Candidate A in full" and "Shared status colours"), mirrored from the
 * design studio mock-up at `docs/design/color-studio/studio.jsx`
 * (`OPTIONS[0]`). Change a colour THERE first, then here; this file is the
 * shipped copy, not the design source.
 *
 * Roles, in the Material 3 sense:
 *   - primary   the brand teal: navigation, selection, links, the one accent
 *   - secondary coral, reserved for EFFORT and training (workouts, sets, PRs)
 *   - tertiary  violet, reserved for AI surfaces
 *   - status    success / warning / error / info — shared by every candidate,
 *               always shown with an icon or a word, never as a series colour
 *   - chart     six categorical series colours, in assignment order; never
 *               used for status, and status colours are never used for series
 */

export interface TonalColorTokens {
  main: string;
  light: string;
  dark: string;
  contrastText: string;
  /** The Material 3 "container" tone: a tinted surface this role can sit on. */
  container: string;
  /** Ink for text and icons placed on `container`. */
  onContainer: string;
}

export interface AccentColorTokens {
  main: string;
  contrastText: string;
}

export interface SchemeTokens {
  primary: TonalColorTokens;
  secondary: TonalColorTokens;
  tertiary: AccentColorTokens;
  success: string;
  warning: string;
  error: string;
  info: string;
  background: { default: string; paper: string };
  /** Tonal surface steps above `paper`, for grouped and nested surfaces. */
  surface: { container1: string; container2: string };
  divider: string;
  /** Border ink for outlined controls (buttons, chips, inputs, toggles). */
  outline: string;
  text: { primary: string; secondary: string };
  chart: { series: string[] };
}

export interface ThemeTokens {
  light: SchemeTokens;
  dark: SchemeTokens;
}

export const TIDAL_TEAL: ThemeTokens = {
  light: {
    primary: {
      // The design value. `theme/light.ts` substitutes `THEME_COLOR` from
      // `packages/shared` for `main`, which is this same colour until a fork
      // rebrands (see the comment there for why the brand colour lives in
      // the shared package rather than in the theme).
      main: '#0F766E',
      light: '#14A08F',
      dark: '#0B5A54',
      contrastText: '#FFFFFF',
      container: '#CCF0EA',
      onContainer: '#0A3F3B',
    },
    secondary: {
      main: '#B8441F',
      light: '#D9603A',
      dark: '#8F3316',
      contrastText: '#FFFFFF',
      container: '#FBE1D6',
      onContainer: '#5A1E0A',
    },
    tertiary: { main: '#4F49C4', contrastText: '#FFFFFF' },
    success: '#1B7F4A',
    warning: '#9C5A00',
    error: '#B42318',
    info: '#0B6AA6',
    background: { default: '#F2F7F6', paper: '#FFFFFF' },
    surface: { container1: '#E7EFEE', container2: '#DBE6E5' },
    divider: '#D0DDDB',
    outline: '#6B8481',
    text: { primary: '#0E1F1D', secondary: '#4A605D' },
    chart: { series: ['#0d9488', '#d97706', '#4f46e5', '#db2777', '#0284c7', '#65a30d'] },
  },
  dark: {
    primary: {
      main: '#4FCDBC',
      light: '#8BE3D6',
      dark: '#2BA897',
      contrastText: '#04302B',
      container: '#0F4F49',
      onContainer: '#B6F0E7',
    },
    secondary: {
      main: '#F0906E',
      light: '#F7B59C',
      dark: '#D96F4A',
      contrastText: '#3A1407',
      container: '#5C2A17',
      onContainer: '#FBD9CB',
    },
    tertiary: { main: '#B4ABF4', contrastText: '#1E1A5C' },
    success: '#62C68E',
    warning: '#E6B452',
    error: '#F28B82',
    info: '#7DB9EE',
    background: { default: '#0B1413', paper: '#122020' },
    surface: { container1: '#192B2A', container2: '#213634' },
    divider: '#2A423F',
    outline: '#7E9794',
    text: { primary: '#E3EEEC', secondary: '#9CB2AE' },
    chart: { series: ['#1fa396', '#c98500', '#9085e9', '#d55181', '#3987e5', '#6f9a1a'] },
  },
};
