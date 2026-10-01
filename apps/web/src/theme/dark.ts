import { alpha, createTheme, PaletteOptions } from '@mui/material/styles';
import { TIDAL_TEAL } from './tokens';

const t = TIDAL_TEAL.dark;

// See `light.ts`: a throw-away dark-mode palette so `tertiary` gets its
// `light`/`dark` derived with the dark-mode `tonalOffset` direction.
const { augmentColor } = createTheme({ palette: { mode: 'dark' } }).palette;

/**
 * The dark colour scheme (`theme/index.ts` → `colorSchemes.dark`), built from
 * the Tidal Teal tokens in `tokens.ts`. The brand colour is not substituted
 * here: `THEME_COLOR` is the light-mode teal, and the dark scheme needs the
 * lifted tint the design doc pairs with it.
 */
export const darkPalette: PaletteOptions = {
  mode: 'dark',
  primary: {
    main: t.primary.main,
    light: t.primary.light,
    dark: t.primary.dark,
    contrastText: t.primary.contrastText,
    container: t.primary.container,
    onContainer: t.primary.onContainer,
  },
  secondary: {
    main: t.secondary.main,
    light: t.secondary.light,
    dark: t.secondary.dark,
    contrastText: t.secondary.contrastText,
    container: t.secondary.container,
    onContainer: t.secondary.onContainer,
  },
  tertiary: augmentColor({ color: t.tertiary, name: 'tertiary' }),
  success: { main: t.success },
  warning: { main: t.warning },
  error: { main: t.error },
  info: { main: t.info },
  background: { default: t.background.default, paper: t.background.paper },
  surface: { container1: t.surface.container1, container2: t.surface.container2 },
  divider: t.divider,
  outline: t.outline,
  text: { primary: t.text.primary, secondary: t.text.secondary },
  chart: { series: [...t.chart.series] },
  action: {
    hover: alpha(t.text.primary, 0.06),
    selected: alpha(t.primary.main, 0.18),
    selectedOpacity: 0.18,
  },
};
