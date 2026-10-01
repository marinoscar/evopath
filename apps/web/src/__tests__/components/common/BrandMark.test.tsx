import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { BrandMark } from '../../../components/common/BrandMark';
import { theme } from '../../../theme';

/**
 * `BrandMark` — the path-and-dot logo as inline SVG.
 *
 * Geometry is the favicon's (`public/favicon.svg`); these tests hold the
 * STRUCTURE (which elements each variant draws), the colour sourcing (theme
 * values for the plate, `currentColor` for the glyph) and the prop plumbing
 * (`size`, pass-through attributes) rather than the path data itself.
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

    it('paints the plate in primary.main and the mark in primary.contrastText', () => {
      const { svg } = renderMark(<BrandMark />);
      const { main, contrastText } = theme.colorSchemes.light!.palette.primary;

      expect(svg.querySelector('rect')).toHaveAttribute('fill', main);
      expect(svg.querySelector('path')).toHaveAttribute('stroke', contrastText);
      expect(svg.querySelector('circle')).toHaveAttribute('fill', contrastText);
    });

    it('takes its colours from the active scheme', () => {
      const { svg } = renderMark(<BrandMark />, 'dark');
      const { main, contrastText } = theme.colorSchemes.dark!.palette.primary;

      expect(svg.querySelector('rect')).toHaveAttribute('fill', main);
      expect(svg.querySelector('path')).toHaveAttribute('stroke', contrastText);
    });
  });

  describe('glyph variant', () => {
    it('draws the path and the dot but no plate', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelectorAll('rect')).toHaveLength(0);
      expect(svg.querySelectorAll('path')).toHaveLength(1);
      expect(svg.querySelectorAll('circle')).toHaveLength(1);
    });

    it('is painted in currentColor so it inherits the surrounding text colour', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelector('path')).toHaveAttribute('stroke', 'currentColor');
      expect(svg.querySelector('circle')).toHaveAttribute('fill', 'currentColor');
    });

    it('does not paint the path with a filled interior', () => {
      const { svg } = renderMark(<BrandMark variant="glyph" />);

      expect(svg.querySelector('path')).toHaveAttribute('fill', 'none');
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
