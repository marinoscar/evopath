import { describe, it, expect } from 'vitest';
import { THEME_COLOR } from '@app/shared';
import { theme } from '../../theme';

/**
 * The application theme (`theme/index.ts`): one MUI theme, two colour schemes
 * (Tidal Teal, `theme/tokens.ts`), CSS variables keyed on a `.light` / `.dark`
 * class.
 *
 * Everything here reads the theme OBJECT's `colorSchemes`, never rendered
 * output: with a CSS-variables theme a rendered colour is a
 * `var(--mui-palette-…)` reference that jsdom cannot resolve.
 *
 * The WCAG block is the theme-level counterpart of the per-component contrast
 * suites (e.g. `DataTableContrast.test.tsx`): it holds the PALETTE to the
 * floors the design doc (`docs/design/color-scheme-options.md` §5) claims, so a
 * token edit that quietly drops a pair below its floor fails here, by name,
 * rather than in whichever component happens to paint it.
 */

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const palette = (scheme: Scheme) => theme.colorSchemes[scheme]!.palette;

// ---------------------------------------------------------------------------
// Local WCAG 2.1 contrast helper (same formula as
// `components/datatable/__tests__/testUtils/contrast.ts`, kept local so this
// suite does not depend on another feature's test utilities). Accepts the
// `#rrggbb` the tokens use and the `rgb(r, g, b)` MUI derives for `tertiary`.
// ---------------------------------------------------------------------------

function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/i.exec(color.trim());
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  throw new Error(`theme.test: unrecognised colour "${color}"`);
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AAA_NORMAL_TEXT = 7;
const AA_NORMAL_TEXT = 4.5;
const AA_UI_COMPONENT = 3;

describe('theme: structure', () => {
  it('carries both colour schemes', () => {
    expect(Object.keys(theme.colorSchemes).sort()).toEqual(['dark', 'light']);
    expect(palette('light').mode).toBe('light');
    expect(palette('dark').mode).toBe('dark');
  });

  it('keys the CSS variables on a class selector, not a media query', () => {
    // `ThemeContext` relies on toggling `.light` / `.dark` on <html>.
    expect(theme.colorSchemeSelector).toBe('class');
    // CSS-variables mode is on: `theme.vars` exists and points at variables.
    expect(theme.vars).toBeDefined();
    expect(theme.vars.palette.primary.main).toMatch(/^var\(--mui-palette-primary-main/);
  });

  it('exposes no per-mode theme exports any more', async () => {
    const exported = await import('../../theme');
    expect(Object.keys(exported)).toEqual(['theme']);
  });
});

describe('theme: brand and role tokens', () => {
  it('uses the shared THEME_COLOR as the light primary', () => {
    expect(palette('light').primary.main).toBe(THEME_COLOR);
  });

  it('uses the lifted teal as the dark primary', () => {
    expect(palette('dark').primary.main).toBe('#4FCDBC');
  });

  it.each(SCHEMES)('%s: defines tertiary with main, light, dark and contrastText', (scheme) => {
    const { tertiary } = palette(scheme);
    expect(tertiary).toBeDefined();
    for (const key of ['main', 'light', 'dark', 'contrastText'] as const) {
      expect(tertiary[key], `${scheme} tertiary.${key}`).toEqual(expect.any(String));
      expect(tertiary[key].length, `${scheme} tertiary.${key}`).toBeGreaterThan(0);
    }
  });

  it.each(SCHEMES)('%s: defines the tonal surfaces and the outline ink', (scheme) => {
    const p = palette(scheme);
    expect(p.surface.container1).toEqual(expect.any(String));
    expect(p.surface.container2).toEqual(expect.any(String));
    expect(p.outline).toEqual(expect.any(String));
    // Distinct steps: a surface that equals paper cannot group anything.
    expect(p.surface.container1).not.toBe(p.background.paper);
    expect(p.surface.container2).not.toBe(p.surface.container1);
  });
});

describe('theme: chart series', () => {
  it.each(SCHEMES)('%s: has exactly six series colours', (scheme) => {
    expect(palette(scheme).chart.series).toHaveLength(6);
  });

  it.each(SCHEMES)('%s: series colours are distinct', (scheme) => {
    const series = palette(scheme).chart.series.map((c) => c.toLowerCase());
    expect(new Set(series).size).toBe(series.length);
  });

  it.each(SCHEMES)(
    '%s: no series colour equals a status colour (status is never a series)',
    (scheme) => {
      const p = palette(scheme);
      const status = [p.success.main, p.warning.main, p.error.main, p.info.main].map((c) =>
        c.toLowerCase(),
      );
      for (const colour of p.chart.series) {
        expect(status, `series ${colour} collides with a status colour`).not.toContain(
          colour.toLowerCase(),
        );
      }
    },
  );
});

describe.each(SCHEMES)('theme: WCAG contrast (%s scheme)', (scheme) => {
  const p = palette(scheme);

  it(`text.primary on background.default is AAA (>= ${AAA_NORMAL_TEXT}:1)`, () => {
    expect(contrast(p.text.primary, p.background.default)).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT);
  });

  it(`text.secondary on background.default is AA (>= ${AA_NORMAL_TEXT}:1)`, () => {
    expect(contrast(p.text.secondary, p.background.default)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it(`text.secondary on surface.container1 is AA (>= ${AA_NORMAL_TEXT}:1)`, () => {
    expect(contrast(p.text.secondary, p.surface.container1)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it(`primary.main on background.paper is AA (>= ${AA_NORMAL_TEXT}:1)`, () => {
    expect(contrast(p.primary.main, p.background.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it(`primary.contrastText on primary.main is AA (>= ${AA_NORMAL_TEXT}:1)`, () => {
    expect(contrast(p.primary.contrastText, p.primary.main)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it(`primary.onContainer on primary.container is AA (>= ${AA_NORMAL_TEXT}:1)`, () => {
    expect(p.primary.container).toBeDefined();
    expect(p.primary.onContainer).toBeDefined();
    expect(contrast(p.primary.onContainer!, p.primary.container!)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  it.each(['success', 'warning', 'error', 'info'] as const)(
    `%s.main on background.paper is AA (>= ${AA_NORMAL_TEXT}:1)`,
    (status) => {
      expect(contrast(p[status].main, p.background.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );

  it(`outline on background.paper clears the UI-component floor (>= ${AA_UI_COMPONENT}:1)`, () => {
    expect(contrast(p.outline, p.background.paper)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
  });

  it.each(Array.from({ length: 6 }, (_, i) => i))(
    `chart series %i on background.paper clears the graphical-object floor (>= ${AA_UI_COMPONENT}:1)`,
    (index) => {
      const colour = p.chart.series[index];
      expect(
        contrast(colour, p.background.paper),
        `${scheme} series ${index} (${colour})`,
      ).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    },
  );
});

describe('theme: the contrast helper', () => {
  it('reports black on white as exactly 21:1', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('reports a colour against itself as 1:1', () => {
    expect(contrast('#0F766E', '#0F766E')).toBeCloseTo(1, 5);
  });

  it('reads the rgb() strings MUI derives for tertiary', () => {
    expect(contrast('rgb(0, 0, 0)', '#FFFFFF')).toBeCloseTo(21, 5);
  });
});
