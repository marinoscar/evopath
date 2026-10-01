import type { SVGProps } from 'react';
import { useTheme } from '@mui/material';

/**
 * The brand mark, "the path", as inline SVG.
 *
 * The same geometry as `public/favicon.svg` (the 32 canvas, mark box at 80%):
 * one smooth stroke that enters low on the left, dips once, climbs to the
 * upper right and ends in a filled dot — the latest measurement, "you are
 * here". The vector masters and the raster generator
 * (`public/icons/source.svg`, `scripts/generate-icons.py`) carry the full
 * geometry notes; this file restates only the numbers it draws, and MUST be
 * kept in step with them when the mark changes.
 *
 * Inline rather than an `<img src="/favicon.svg">` so the plate takes its
 * colour from the live MUI theme (`palette.primary.main` /
 * `primary.contrastText`) instead of from the hex literal baked into the
 * file, and so the `glyph` variant can be painted in `currentColor` — in a
 * list, a button, or any text run, at whatever colour its parent has.
 *
 * Purely decorative by default: callers that place it beside the wordmark
 * pass `aria-hidden`, which spreads onto the `<svg>`. A caller that renders it
 * ALONE as the product's identity passes `role="img"` and an `aria-label`
 * instead.
 */
export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Rendered width and height in CSS pixels. */
  size?: number;
  /**
   * `plate`: the white path on the teal rounded square — the app icon.
   * `glyph`: the path alone, in `currentColor`, for inline use.
   */
  variant?: 'plate' | 'glyph';
}

// The favicon crop on the 32 canvas: mark box 25.6 a side at origin 3.2.
const PATH_D =
  'M3.71 23.17 C7.3 23.17 10.37 26.75 13.95 26.24 C18.56 25.73 22.14 8.83 28.29 7.81';
const STROKE_WIDTH = 4.1; // 0.16 x 25.6
const END_DOT = { cx: 28.29, cy: 7.81, r: 3.33 }; // radius 0.13 x 25.6
const PLATE_RADIUS = 7.04; // 0.22 x 32

export function BrandMark({ size = 28, variant = 'plate', ...rest }: BrandMarkProps) {
  const theme = useTheme();
  const isPlate = variant === 'plate';
  const ink = isPlate ? theme.palette.primary.contrastText : 'currentColor';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      focusable="false"
      {...rest}
    >
      {isPlate && (
        <rect width="32" height="32" rx={PLATE_RADIUS} fill={theme.palette.primary.main} />
      )}
      <path
        d={PATH_D}
        fill="none"
        stroke={ink}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={END_DOT.cx} cy={END_DOT.cy} r={END_DOT.r} fill={ink} />
    </svg>
  );
}
