import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '../../theme';
import { chartSeries, useChartSeries } from '../../theme/chartPalette';

/**
 * `useChartSeries()` returns REAL colour strings for the scheme on screen.
 * Charts interpolate their colours, so they cannot take the
 * `var(--mui-palette-…)` references a CSS-variables theme otherwise emits.
 */

const LIGHT = theme.colorSchemes.light!.palette.chart.series;
const DARK = theme.colorSchemes.dark!.palette.chart.series;

function wrapperFor(defaultMode: 'light' | 'dark') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider theme={theme} defaultMode={defaultMode} forceThemeRerender noSsr>
        {children}
      </ThemeProvider>
    );
  };
}

describe('useChartSeries', () => {
  it('returns the light series under defaultMode="light"', () => {
    const { result } = renderHook(() => useChartSeries(), { wrapper: wrapperFor('light') });
    expect(result.current).toEqual(LIGHT);
  });

  it('returns the dark series under defaultMode="dark"', () => {
    const { result } = renderHook(() => useChartSeries(), { wrapper: wrapperFor('dark') });
    expect(result.current).toEqual(DARK);
  });

  it('the two schemes carry different lists, so the assertions above discriminate', () => {
    expect(LIGHT).toHaveLength(6);
    expect(DARK).toHaveLength(6);
    expect(LIGHT).not.toEqual(DARK);
  });

  it('returns literal colour strings, never CSS variable references', () => {
    const { result } = renderHook(() => useChartSeries(), { wrapper: wrapperFor('dark') });
    for (const colour of result.current) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('returns a copy, so a chart cannot mutate the theme', () => {
    const { result } = renderHook(() => useChartSeries(), { wrapper: wrapperFor('light') });
    result.current.push('#000000');
    expect(theme.colorSchemes.light!.palette.chart.series).toHaveLength(6);
  });

  it('falls back to the theme palette outside any colour-scheme provider', () => {
    const { result } = renderHook(() => useChartSeries());
    // No provider: `useTheme()` is MUI's default theme, which carries no
    // `chart` palette, so the hook answers an empty list rather than throwing.
    expect(result.current).toEqual([]);
  });
});

describe('chartSeries', () => {
  it('reads the named scheme straight from theme.colorSchemes', () => {
    expect(chartSeries(theme, 'light')).toEqual(LIGHT);
    expect(chartSeries(theme, 'dark')).toEqual(DARK);
  });

  it('uses theme.palette when no scheme is named', () => {
    expect(chartSeries(theme)).toEqual(theme.palette.chart.series);
  });
});
