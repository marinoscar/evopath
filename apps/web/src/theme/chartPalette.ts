import { useMemo } from 'react';
import { useColorScheme, useTheme, type Theme } from '@mui/material/styles';

/**
 * The categorical chart series for a theme — `palette.chart.series` from
 * `tokens.ts`, six colours in assignment order.
 *
 * Charts need REAL colour strings (`@mui/x-charts` interpolates and blends
 * them), not `var(--mui-palette-…)` references, and a CSS-variables theme's
 * top-level `theme.palette` is the DEFAULT scheme's unless the provider was
 * mounted with `forceThemeRerender`. So the caller may name the scheme it is
 * rendering in and the series is read from `theme.colorSchemes[scheme]`
 * directly; without one, `theme.palette` is used as is.
 *
 * Rule (design doc §3): series colours are never used for status, and status
 * colours (`success`/`warning`/`error`/`info`) are never used as a generic
 * series colour.
 */
export function chartSeries(theme: Theme, scheme?: 'light' | 'dark'): string[] {
  const schemePalette = scheme ? theme.colorSchemes?.[scheme]?.palette : undefined;
  const series = (schemePalette ?? theme.palette).chart?.series;
  return series ? [...series] : [];
}

/**
 * `chartSeries` for the scheme currently on screen. Outside a colour-scheme
 * provider (a bare `ThemeProvider` in a test) `useColorScheme` reports no
 * mode and the theme's own palette is used.
 */
export function useChartSeries(): string[] {
  const theme = useTheme();
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === 'system' ? systemMode : mode;
  const scheme = resolved === 'dark' || resolved === 'light' ? resolved : undefined;
  return useMemo(() => chartSeries(theme, scheme), [theme, scheme]);
}
