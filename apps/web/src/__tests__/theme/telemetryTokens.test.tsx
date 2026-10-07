/**
 * EvoPath's theme through the packaged telemetry token contract
 * (`@marinoscar/platform-web/telemetry`, marinoscar/EnterpriseAppBase#719).
 *
 * The packaged telemetry charts (`MetricSeriesChart`, `ApiTimelineChart`,
 * `LogSeverityChart`) read their colours through `useTelemetryTokens()`:
 * `palette.chart.series` for series and `palette.status` for meaning. This
 * app's own copies of those three charts read `useChartSeries()`
 * (`theme/chartPalette.ts`), `palette.{success,warning,error,info}` and
 * `palette.outline`. These cases prove the packaged charts paint exactly what
 * the app's copies painted, in light and in dark, so EvoPath's chart colours
 * are unchanged by the adoption.
 *
 * `MetricSeriesChart` itself is internal to the package (not exported), so
 * the hook it calls is rendered here under the app's real theme and provider
 * settings (`forceThemeRerender`, as `contexts/ThemeContext.tsx` mounts it).
 */
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { telemetryTokens, useTelemetryTokens } from '@marinoscar/platform-web/telemetry/headless';

import { theme } from '../../theme';
import { telemetryStatusTokens } from '../../theme/telemetryTokens';
import { useChartSeries } from '../../theme/chartPalette';
import { TIDAL_TEAL } from '../../theme/tokens';

function wrapperFor(defaultMode: 'light' | 'dark') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider theme={theme} defaultMode={defaultMode} forceThemeRerender noSsr>
        {children}
      </ThemeProvider>
    );
  };
}

describe.each(['light', 'dark'] as const)('the %s scheme', (scheme) => {
  const t = TIDAL_TEAL[scheme];

  it("gives the packaged charts tokens.ts's own chart series, first colour first", () => {
    const { result } = renderHook(() => useTelemetryTokens(), { wrapper: wrapperFor(scheme) });

    expect(result.current.chart.series[0]).toBe(t.chart.series[0]);
    expect(result.current.chart.series).toEqual(t.chart.series);
  });

  it("paints the same series as the app's own useChartSeries()", () => {
    const tokens = renderHook(() => useTelemetryTokens(), { wrapper: wrapperFor(scheme) });
    const app = renderHook(() => useChartSeries(), { wrapper: wrapperFor(scheme) });

    expect(tokens.result.current.chart.series).toEqual(app.result.current);
  });

  it("maps status onto tokens.ts's status colours, and neutral onto outline", () => {
    const { result } = renderHook(() => useTelemetryTokens(), { wrapper: wrapperFor(scheme) });

    expect(result.current.status).toEqual({
      ok: t.success,
      warn: t.warning,
      crit: t.error,
      info: t.info,
      neutral: t.outline,
    });
    expect(result.current.status).toEqual(telemetryStatusTokens(t));
  });

  it('declares the tokens in the scheme palette itself, so nothing is derived', () => {
    const palette = theme.colorSchemes[scheme]!.palette;

    expect(palette.status).toEqual(telemetryStatusTokens(t));
    expect(palette.chart.series).toEqual(t.chart.series);
  });
});

describe('the two schemes', () => {
  it('carry different series and status colours, so the cases above discriminate', () => {
    expect(TIDAL_TEAL.light.chart.series[0]).not.toBe(TIDAL_TEAL.dark.chart.series[0]);
    expect(TIDAL_TEAL.light.error).not.toBe(TIDAL_TEAL.dark.error);
  });

  it('every token is a literal colour, never a CSS variable reference', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = telemetryTokens({ ...theme, palette: theme.colorSchemes[scheme]!.palette } as typeof theme);
      for (const colour of [...tokens.chart.series, ...Object.values(tokens.status)]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
