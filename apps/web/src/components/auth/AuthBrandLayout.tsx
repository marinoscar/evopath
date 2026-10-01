import type { ReactNode } from 'react';
import { Box, Card, Typography, Stack } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { APP_NAME, THEME_COLOR } from '@app/shared';
import { BrandMark } from '../common/BrandMark';
import {
  BRAND_MARK_GLYPH_STANDARD,
  BRAND_MARK_VIEWBOX,
} from '../common/brandMarkPaths.generated';

/** One calm line about what the product is for, under the name. */
export const AUTH_TAGLINE = 'Your path to better health, measured.';

/** The brand glyph's size in the wide layout's brand panel. */
const BRAND_GLYPH_SIZE = 120;

/**
 * Where the sun sits inside the glyph, as a fraction of its box, read from the
 * generated geometry so the glow behind the glyph stays centred on the sun
 * whenever the mark is regenerated.
 */
const SUN_X = BRAND_MARK_GLYPH_STANDARD.sun.cx / BRAND_MARK_VIEWBOX;
const SUN_Y = BRAND_MARK_GLYPH_STANDARD.sun.cy / BRAND_MARK_VIEWBOX;

interface AuthBrandLayoutProps {
  /** The content of the right-hand panel (the whole card below `md`). */
  children: ReactNode;
}

/**
 * The shared shell of the full-page, signed-out screens: the sign-in page and
 * the "no access" screen a failed sign-in ends on.
 *
 * LAYOUT
 * - `md` and up: one card split in two. Left, a brand panel: the brand teal
 *   with a soft glow radiating from the logo's sun, the large glyph, the
 *   product name and a one-line tagline. Right, `children` on
 *   `background.paper`.
 * - Below `md`: one column. A compact brand header (plate mark + name) above
 *   the card holding `children`.
 *
 * The switch is pure CSS (`display` per breakpoint), not a `useMediaQuery`
 * mount gate, so this adds nothing to the five coupled `sm` gates in
 * `Layout.tsx` / `BottomNav` / `AppBar` / `SettingsHub` (it does not mount
 * `Layout` at all). Whichever brand block is hidden is `display: none`, so it
 * is also out of the accessibility tree: the product name is announced once.
 * The brand name is a paragraph, not a heading: the page's single `h1` is the
 * one inside `children`.
 *
 * COLOUR
 * The brand panel is `primary.main` in light mode (which is `THEME_COLOR`) and
 * stays the brand teal `THEME_COLOR` in dark mode rather than taking the dark
 * scheme's lighter primary: it is the logo's ground, and the logo is
 * brand-fixed (see `BrandMark`). Everything else uses scheme tokens.
 */
export function AuthBrandLayout({ children }: AuthBrandLayoutProps) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        px: 2,
        py: { xs: 4, md: 6 },
      }}
    >
      {/* Compact brand header, below md only. Decorative mark: the name
          beside it is the text. */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ display: { xs: 'flex', md: 'none' }, alignItems: 'center', mb: 3 }}
      >
        <BrandMark size={56} variant="plate" aria-hidden />
        <Typography component="p" variant="h5" sx={{ fontWeight: 700 }}>
          {APP_NAME}
        </Typography>
      </Stack>

      <Card
        sx={{
          width: '100%',
          maxWidth: { xs: 400, md: 920 },
          display: 'flex',
          overflow: 'hidden',
          boxShadow: 10,
        }}
      >
        {/* Brand panel, md and up. */}
        <Box
          sx={(theme) => ({
            display: { xs: 'none', md: 'flex' },
            flex: '1 1 45%',
            flexDirection: 'column',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
            px: 5,
            py: 6,
            minHeight: 480,
            color: 'common.white',
            bgcolor: 'primary.main',
            ...theme.applyStyles('dark', { bgcolor: THEME_COLOR }),
          })}
        >
          <Box sx={{ position: 'relative', width: BRAND_GLYPH_SIZE, height: BRAND_GLYPH_SIZE, mb: 4 }}>
            {/* The glow: a soft light centred on the logo's sun. Decorative,
                behind the glyph, and wide enough to tint the panel. */}
            <Box
              aria-hidden
              sx={(theme) => ({
                position: 'absolute',
                width: 520,
                height: 520,
                left: BRAND_GLYPH_SIZE * SUN_X - 260,
                top: BRAND_GLYPH_SIZE * SUN_Y - 260,
                borderRadius: '50%',
                pointerEvents: 'none',
                background: `radial-gradient(circle, ${alpha(theme.palette.common.white, 0.2)} 0%, ${alpha(theme.palette.common.white, 0.07)} 35%, transparent 70%)`,
              })}
            />
            <BrandMark
              size={BRAND_GLYPH_SIZE}
              variant="glyph"
              aria-hidden
              style={{ position: 'relative', display: 'block' }}
            />
          </Box>
          <Typography
            component="p"
            variant="h3"
            sx={{ position: 'relative', fontWeight: 700, letterSpacing: '-0.01em' }}
          >
            {APP_NAME}
          </Typography>
          <Typography
            sx={(theme) => ({
              position: 'relative',
              mt: 1.5,
              maxWidth: 360,
              textWrap: 'balance',
              fontSize: '1.125rem',
              color: alpha(theme.palette.common.white, 0.85),
            })}
          >
            {AUTH_TAGLINE}
          </Typography>
        </Box>

        {/* Content panel. */}
        <Box
          sx={{
            flex: '1 1 55%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            bgcolor: 'background.paper',
            p: { xs: 4, md: 6 },
          }}
        >
          {children}
        </Box>
      </Card>
    </Box>
  );
}
