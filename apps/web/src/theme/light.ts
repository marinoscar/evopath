import { alpha, createTheme, PaletteOptions } from '@mui/material/styles';
import { THEME_COLOR } from '@app/shared';
import { TIDAL_TEAL } from './tokens';

const t = TIDAL_TEAL.light;

// `augmentColor` for the roles the token set gives only a `main` and a
// `contrastText` for (`tertiary`): MUI derives `light`/`dark` from `main`
// and `tonalOffset`, and components such as `Button color="tertiary"` read
// all four. A throw-away light-mode palette supplies the correct mode-aware
// derivation; the resulting theme is discarded.
const { augmentColor } = createTheme({ palette: { mode: 'light' } }).palette;

/**
 * The light colour scheme (`theme/index.ts` → `colorSchemes.light`), built
 * from the Tidal Teal tokens in `tokens.ts`.
 */
export const lightPalette: PaletteOptions = {
  mode: 'light',
  primary: {
    // Issue #216: the brand colour is `THEME_COLOR` in `packages/shared/index.js`,
    // not a literal here. The manifest's `theme_color` and the committed icons
    // under `public/icons/` cannot import this palette, so if the value lived in
    // the theme a rebrand would restyle the app and leave the installed-app
    // surfaces on the old colour.
    //
    // `light` and `dark` are the Tidal Teal tints from the design doc
    // (`tokens.ts`), stated explicitly on purpose: MUI would otherwise compute
    // them from `main` with `tonalOffset` — a different pair of colours than
    // the two the design validated, and a visual change nobody asked for.
    main: THEME_COLOR,
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
    selected: alpha(t.primary.main, 0.12),
    selectedOpacity: 0.12,
  },
};
