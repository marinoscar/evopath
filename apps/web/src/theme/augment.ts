/**
 * MUI module augmentation for the Tidal Teal theme (`theme/index.ts`).
 *
 * Adds the custom palette roles the token set carries beyond MUI's defaults
 * (`tokens.ts`): a `tertiary` colour, Material 3 `container` / `onContainer`
 * tones on every palette colour, tonal `surface` steps, an `outline` ink and
 * the categorical `chart.series`. It also opts the `tertiary` colour into the
 * components that take a `color` prop, and switches on the CSS-variables
 * typings so `theme.vars` is non-optional and `ThemeProvider` accepts
 * `forceThemeRerender`.
 *
 * A MODULE (`export {}`), not a `.d.ts` script: a script's `declare module`
 * would redeclare the package instead of augmenting it, and a `.d.ts` is only
 * seen by programs whose `include` happens to cover it. `theme/index.ts`
 * imports this file for its side effect, so every program that compiles the
 * theme — the app (`tsconfig.json`), the visual harness
 * (`visual/tsconfig.json`), vitest — gets the augmentation with it.
 */

import type { PaletteColorOptions } from '@mui/material/styles';

export {};

declare module '@mui/material/styles' {
  interface CssThemeVariables {
    enabled: true;
  }

  interface PaletteColor {
    container?: string;
    onContainer?: string;
  }

  interface SimplePaletteColorOptions {
    container?: string;
    onContainer?: string;
  }

  interface PaletteSurface {
    container1: string;
    container2: string;
  }

  interface PaletteChart {
    series: string[];
  }

  interface Palette {
    tertiary: PaletteColor;
    surface: PaletteSurface;
    outline: string;
    chart: PaletteChart;
  }

  interface PaletteOptions {
    tertiary?: PaletteColorOptions;
    surface?: Partial<PaletteSurface>;
    outline?: string;
    chart?: Partial<PaletteChart>;
  }
}

declare module '@mui/material/Button' {
  interface ButtonPropsColorOverrides {
    tertiary: true;
  }
}

declare module '@mui/material/Chip' {
  interface ChipPropsColorOverrides {
    tertiary: true;
  }
}

declare module '@mui/material/IconButton' {
  interface IconButtonPropsColorOverrides {
    tertiary: true;
  }
}

declare module '@mui/material/CircularProgress' {
  interface CircularProgressPropsColorOverrides {
    tertiary: true;
  }
}

declare module '@mui/material/LinearProgress' {
  interface LinearProgressPropsColorOverrides {
    tertiary: true;
  }
}
