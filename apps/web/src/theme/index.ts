import './augment';
import { createTheme } from '@mui/material/styles';
import { lightPalette } from './light';
import { darkPalette } from './dark';
import { componentOverrides } from './components';

/**
 * THE application theme: one MUI theme, two colour schemes, CSS variables.
 *
 * `cssVariables` makes MUI emit every palette value as a custom property
 * (`--mui-palette-primary-main`, …) once per scheme, and
 * `colorSchemeSelector: 'class'` keys the two sets on a `.light` / `.dark`
 * class on `<html>`, which `ThemeProvider` toggles. Switching modes therefore
 * flips a class, not the theme object — components styled through
 * `theme.vars` or `sx` string tokens (`'primary.main'`) re-colour without
 * re-rendering. `contexts/ThemeContext.tsx` is the only place that mounts
 * this theme, with `forceThemeRerender` so `theme.palette` (read directly by
 * charts and a handful of `palette.mode` checks) also follows the scheme.
 *
 * The colours are the Tidal Teal tokens (`tokens.ts`), one palette per scheme
 * (`light.ts`, `dark.ts`). Component overrides are in `components.ts`.
 */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: lightPalette },
    dark: { palette: darkPalette },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: { fontWeight: 600 },
    h2: { fontWeight: 600 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 700, letterSpacing: '-0.01em' },
    h5: { fontWeight: 650 },
    h6: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    button: { fontWeight: 600, textTransform: 'none' },
    overline: { fontWeight: 600, letterSpacing: '0.08em' },
  },
  shape: {
    borderRadius: 12,
  },
  components: componentOverrides,
});

export type ThemeMode = 'light' | 'dark' | 'system';
