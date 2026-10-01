import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ACCENT_COLOR, THEME_COLOR } from '@app/shared';
import { BrandMark } from '../../../components/common/BrandMark';
import {
  BRAND_MARK_GLYPH_COMPACT,
  BRAND_MARK_GLYPH_STANDARD,
  BRAND_MARK_PLATE_COMPACT,
  BRAND_MARK_PLATE_STANDARD,
} from '../../../components/common/brandMarkPaths.generated';
import { theme } from '../../../theme';

/**
 * `BrandMark` — the path-and-dot logo as inline SVG.
 *
 * The geometry is generated (`brandMarkPaths.generated.ts`); these tests hold
 * the STRUCTURE (which elements each variant draws), the colour sourcing
 * (brand-fixed plate, white or `currentColor` road, `ACCENT_COLOR` sun), which
 * generated geometry `compact` selects, and the prop plumbing (`size`,
 * pass-through attributes). The road is a FILLED path, not a stroke.
 */

function renderMark(ui: ReactElement, mode: 'light' | 'dark' = 'light') {
  const utils = render(
    <ThemeProvider theme={theme} defaultMode={mode} forceThemeRerender noSsr>
      {ui}
    </ThemeProvider>,
  );
  const svg = utils.container.querySelector('svg') as SVGSVGElement;
  return { ...utils, svg };
}

describe('BrandMark', () => {
  describe('plate variant (the default)', () => {
    it('draws the rounded plate, the path and the end dot', () => {
      const { svg } = renderMark(<BrandMark />);

      expect(svg.querySelectorAll('rect')).toHaveLength(1);
      expect(svg.querySelectorAll('path')).toHaveLength(1);
      expect(svg.querySelectorAll('circle')).toHaveLength(1);
    });

    it('is the default when no variant is given', () => {
      const { svg } = renderMark(<BrandMark />);
      const { svg: explicit } = renderMark(<BrandMark variant="plate" />);

      expect(svg.innerHTML).toBe(explicit.innerHTML);
    });

    it('paints the plate in primary.main (the brand teal), a white (#fff) filled road and the accent sun', () => {
      const { svg } = renderMark(<BrandMark />);
      const { main } = theme.colorSchemes.light!.palette.primary;
      const road = svg.querySelector('path')!;

      expect(svg.querySelector('rect')).toHaveAttribute('fill', main);
      expect(road).toHaveAttribute('fill', '#fff');
      expect(road).not.toHaveAttribute('stroke');
      expect(svg.querySelector('circle')).toHaveAttribute('fill', ACCENT_COLOR);
    });

    it('keeps the plate on THEME_COLOR in dark mode, not the dark scheme primary', () => {
      const { svg } = renderMark(<BrandMark />, 'dark');
      const darkPrimary = theme.colorSchemes.dark!.palette.primary.main;

      expect(svg.querySelector('rect')).toHaveAttribute('fill', THEME_COLOR);
      expect(darkPrimary.toLowerCase()).not.toBe(THEME_COLOR.toLowerCase());
      expect(svg.querySelector('rect')).not.toHaveAttribute('fill', darkPrimary);
      // The rest of the mark does not re-tone with the scheme either.
      expect(svg.querySelector('path')).toHaveAttribute('fill', '#fff');
      expect(svg.querySelector('circle')).toHaveAttribute('fill', ACCENT_COLOR);
    });
  });

  describe('glyph variant', () => {
    it('draws the path and the dot but no plate', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelectorAll('rect')).toHaveLength(0);
      expect(svg.querySelectorAll('path')).toHaveLength(1);
      expect(svg.querySelectorAll('circle')).toHaveLength(1);
    });

    it('paints the road in currentColor so it inherits the surrounding text colour', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelector('path')).toHaveAttribute('fill', 'currentColor');
    });

    it('keeps the sun in ACCENT_COLOR whatever the text colour', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelector('circle')).toHaveAttribute('fill', ACCENT_COLOR);
    });

    it('draws the road as a filled ribbon, not a stroked line', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);
      const road = svg.querySelector('path')!;

      expect(road).not.toHaveAttribute('stroke');
      expect(road.getAttribute('fill')).not.toBe('none');
      // A closed outline: the generated ribbon ends with `Z`.
      expect(road.getAttribute('d')).toMatch(/Z$/);
    });
  });

  describe('compact geometry', () => {
    const cases = [
      { variant: 'plate', compact: BRAND_MARK_PLATE_COMPACT, standard: BRAND_MARK_PLATE_STANDARD },
      { variant: 'glyph', compact: BRAND_MARK_GLYPH_COMPACT, standard: BRAND_MARK_GLYPH_STANDARD },
    ] as const;

    it('the generated compact and standard roads actually differ', () => {
      for (const c of cases) {
        expect(c.compact.road).not.toBe(c.standard.road);
        expect(c.compact.road.length).toBeGreaterThan(0);
        expect(c.standard.road.length).toBeGreaterThan(0);
      }
    });

    describe.each(cases)('$variant', ({ variant, compact, standard }) => {
      it.each([16, 24, 31])('defaults to the compact geometry at %ipx', (size) => {
        const { svg } = renderMark(<BrandMark variant={variant} size={size} />);

        expect(svg.querySelector('path')).toHaveAttribute('d', compact.road);
        expect(svg.querySelector('circle')).toHaveAttribute('r', String(compact.sun.r));
      });

      it.each([32, 40, 120])('defaults to the standard geometry at %ipx', (size) => {
        const { svg } = renderMark(<BrandMark variant={variant} size={size} />);

        expect(svg.querySelector('path')).toHaveAttribute('d', standard.road);
        expect(svg.querySelector('circle')).toHaveAttribute('cx', String(standard.sun.cx));
        expect(svg.querySelector('circle')).toHaveAttribute('cy', String(standard.sun.cy));
        expect(svg.querySelector('circle')).toHaveAttribute('r', String(standard.sun.r));
      });

      it('uses the compact geometry at the default 28px size', () => {
        const { svg } = renderMark(<BrandMark variant={variant} />);

        expect(svg.querySelector('path')).toHaveAttribute('d', compact.road);
      });

      it('an explicit compact={true} wins over a large size', () => {
        const { svg } = renderMark(<BrandMark variant={variant} size={96} compact />);

        expect(svg.querySelector('path')).toHaveAttribute('d', compact.road);
        expect(svg.querySelector('circle')).toHaveAttribute('cx', String(compact.sun.cx));
      });

      it('an explicit compact={false} wins over a small size', () => {
        const { svg } = renderMark(<BrandMark variant={variant} size={16} compact={false} />);

        expect(svg.querySelector('path')).toHaveAttribute('d', standard.road);
        expect(svg.querySelector('circle')).toHaveAttribute('cx', String(standard.sun.cx));
      });
    });
  });

  describe('size', () => {
    it('defaults to 28 by 28', () => {
      const { svg } = renderMark(<BrandMark />);

      expect(svg).toHaveAttribute('width', '28');
      expect(svg).toHaveAttribute('height', '28');
    });

    it.each([16, 40, 96])('drives width and height together at %ipx', (size) => {
      const { svg } = renderMark(<BrandMark size={size} />);

      expect(svg).toHaveAttribute('width', String(size));
      expect(svg).toHaveAttribute('height', String(size));
    });

    it('keeps the 32-unit viewBox whatever the size, so it scales rather than crops', () => {
      const { svg } = renderMark(<BrandMark size={64} variant="glyph" />);

      expect(svg).toHaveAttribute('viewBox', '0 0 32 32');
    });
  });

  describe('pass-through props', () => {
    it('lands aria-hidden on the <svg>', () => {
      const { svg } = renderMark(<BrandMark aria-hidden />);

      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });

    it('lands role, aria-label and data attributes on the <svg>', () => {
      const { svg } = renderMark(
        <BrandMark role="img" aria-label="Brand" data-testid="brand-mark" className="x" />,
      );

      expect(svg).toHaveAttribute('role', 'img');
      expect(svg).toHaveAttribute('aria-label', 'Brand');
      expect(svg).toHaveAttribute('data-testid', 'brand-mark');
      expect(svg).toHaveClass('x');
    });

    it('is not focusable (a decorative mark must not join the tab order in old Edge/IE)', () => {
      const { svg } = renderMark(<BrandMark />);

      expect(svg).toHaveAttribute('focusable', 'false');
    });
  });
});
