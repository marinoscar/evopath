/**
 * Component tests — DataTable color contrast, computed against the REAL
 * theme (issue #257).
 *
 * `axe-core`'s `color-contrast` rule is disabled in the conformance suite's
 * axe pass (`conformance/runDataTableConformanceSuite.tsx` documents why:
 * jsdom performs no real layout/paint, so the rule cannot resolve an
 * element's true effective background and is a well-known false-negative
 * trap there). This file is the real substitute: a pure WCAG 2.1
 * relative-luminance / contrast-ratio calculator
 * (`testUtils/contrast.ts`) run directly against the actual
 * `lightTheme` / `darkTheme` palette values the app ships
 * (`../../../theme/light.ts`, `dark.ts`) for the specific foreground/
 * background pairs THIS component paints — not a generic "is the theme
 * accessible" audit.
 *
 * ## Every ratio here is pinned against THIS repo's palette
 *
 * The measured ratios in the comments below were computed from the Tidal Teal
 * palettes (`theme/light.ts` / `dark.ts`, built from `theme/tokens.ts`) with
 * this file's own `contrastRatio` helper. They are recorded so that a future
 * palette change shows up as a diff in intent, not just as a pass/fail flip.
 * The tightest pair is `text.secondary` over the detail wash in the light
 * scheme (6.44:1 against a 4.5:1 requirement).
 *
 * ## Foregrounds are opaque; the TINTS are still translucent
 *
 * The Tidal Teal palettes state `text.primary` and `text.secondary` as opaque
 * hex, so a foreground no longer needs compositing. The component-authored
 * tints DataTable paints over the paper (the selected-row wash, the detail
 * wash) are still `rgba()` literals, and a translucent BACKGROUND is the case
 * a naive two-colour check gets wrong: the rendered surface is the tint
 * alpha-composited over paper, not the tint read in isolation. So every
 * assertion that involves a tint passes the opaque backing surface
 * explicitly, and every text assertion keeps passing it too so the call shape
 * stays uniform.
 *
 * These tests read the palette OBJECTS, not rendered output: with a
 * CSS-variables theme, rendered colours are `var(--mui-palette-…)` references
 * that jsdom cannot resolve.
 */

import { describe, it, expect } from 'vitest';
import { theme } from '../../../theme';
import { lightPalette } from '../../../theme/light';
import { darkPalette } from '../../../theme/dark';
import {
  contrastRatio,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_UI_COMPONENT,
} from './testUtils/contrast';

// Component-authored colors that are not part of the theme palette but ARE
// painted by DataTable — the selected-row tint (`DesktopGridRenderer.tsx`'s
// `.MuiDataGrid-row.Mui-selected` equivalent styling, `DataCard.tsx`'s
// selected background) and the bulk-action-bar tint (`BulkActionBar.tsx`).
//
// These are literals in the components themselves (`BulkActionBar.tsx:63-64`,
// `DataCard.tsx:160-161`), not palette lookups, so they are mirrored here
// verbatim rather than derived — verified to match those two files.
// (They are the pre-Tidal-Teal blue tints; the ratios below hold with wide
// margin, but if the components move to palette-derived tints, mirror that
// change here.)
const SELECTED_ROW_TINT_LIGHT = 'rgba(25, 118, 210, 0.06)';
const SELECTED_ROW_TINT_DARK = 'rgba(144, 202, 249, 0.10)';

// The collapsed "More details" region's own backing wash (`DataCard.tsx:279-280`),
// painted over the card's `background.paper`.
const DETAIL_REGION_TINT_LIGHT = 'rgba(0, 0, 0, 0.02)';
const DETAIL_REGION_TINT_DARK = 'rgba(255, 255, 255, 0.03)';

const LIGHT_PAPER = lightPalette.background!.paper!;
const DARK_PAPER = darkPalette.background!.paper!;

describe('DataTable — WCAG contrast (computed against the real theme)', () => {
  describe('body text on the card / paper surface', () => {
    // Measured: 17.04:1. `text.primary` is opaque #0E1F1D over #FFFFFF.
    it('light theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.primary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 6.73:1. `text.secondary` is opaque #4A605D over #FFFFFF.
    it('light theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.secondary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 14.13:1. `text.primary` is opaque #E3EEEC over #122020.
    it('dark theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.primary!, DARK_PAPER, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 7.50:1. `text.secondary` is opaque #9CB2AE over #122020.
    it('dark theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.secondary!, DARK_PAPER, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('body text over the SELECTED-row tint (translucent, composited)', () => {
    // The tint is painted over `background.paper` (the Card / DataGrid row's
    // own surface); text.primary is what sits on top of it in both
    // `DataCard.tsx` and the grid's selected-row styling. A translucent tint
    // is the one case a naive two-color contrast check gets wrong — the
    // ACTUAL rendered background is the tint alpha-composited over paper, not
    // the tint's own (mostly-transparent) color read in isolation.

    // Measured: 15.77:1.
    it('light theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(lightPalette.text!.primary!, SELECTED_ROW_TINT_LIGHT, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 11.43:1.
    it('dark theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(darkPalette.text!.primary!, SELECTED_ROW_TINT_DARK, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('detail-region body text (the card’s collapsed "More details" wash)', () => {
    // The region's `secondary`-column label/value pairs are `text.secondary`
    // over the detail wash over paper — a THREE-layer stack, and the pair with
    // the least headroom in the light theme once alpha is honoured.

    // Measured: 6.44:1.
    it('light theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        lightPalette.text!.secondary!,
        DETAIL_REGION_TINT_LIGHT,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 6.92:1.
    it('dark theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        darkPalette.text!.secondary!,
        DETAIL_REGION_TINT_DARK,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('primary-colored UI elements (chips, links, focus/selection accents)', () => {
    // `primary.main` is what `DataCard.tsx`'s "More details" control, the
    // filter chips (`variant="outlined" color="primary"`), and the selected
    // row's border all use. WCAG 1.4.11 (non-text contrast) sets the floor at
    // 3:1 against its background, not the stricter 4.5:1 for body text.

    // Measured: 5.47:1 — #0F766E on #FFFFFF. Clears AA normal text (4.5:1)
    // too, so `primary.main` text on paper is safe at body size.
    it('light theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // Measured: 8.61:1 — #4FCDBC on #122020.
    it('dark theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The "More details" / "Fewer details" toggle and filter-chip labels are
    // `body2`-sized text COLORED with `primary.main`, not just a border or
    // icon — held to the stricter large-text-or-better floor as a matter of
    // this suite's own discipline, even though WCAG's text rule technically
    // only requires 4.5:1 for genuinely small text.
    it('light theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });

    it('dark theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });
  });

  describe('error (destructive) palette', () => {
    // Destructive row/bulk actions (`destructive: true`) paint in
    // `theme.palette.error.main`, which the Tidal Teal tokens override per
    // scheme (`#B42318` light, `#F28B82` dark). The ratios are computed from
    // the pinned literals; the pin test below ties them to the real theme.

    // Measured: 6.57:1.
    it('light theme: error.main on background.paper meets the UI-component floor', () => {
      const ratio = contrastRatio('#B42318', LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // Measured: 7.01:1.
    it('dark theme: error.main on background.paper meets the UI-component floor', () => {
      const ratio = contrastRatio('#F28B82', DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The two literals above are asserted against the real theme's colour
    // schemes so a palette that changes `error` fails here loudly rather than
    // leaving these two tests quietly checking a dead constant.
    it('pins the error.main values these ratios were computed from', () => {
      expect(theme.colorSchemes.light!.palette.error.main).toBe('#B42318');
      expect(theme.colorSchemes.dark!.palette.error.main).toBe('#F28B82');
      expect(lightPalette.error).toEqual({ main: '#B42318' });
      expect(darkPalette.error).toEqual({ main: '#F28B82' });
    });
  });

  describe('the calculator itself', () => {
    // Guards the calculator's compositing: `text.secondary` must stay
    // measurably below `text.primary`, so a regression that flattens both onto
    // one ratio (e.g. mishandling the backing surface) is caught here.
    it('light theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(lightPalette.text!.primary!, LIGHT_PAPER, LIGHT_PAPER);
      const secondary = contrastRatio(lightPalette.text!.secondary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(secondary).toBeLessThan(primary);
    });

    it('dark theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(darkPalette.text!.primary!, DARK_PAPER, DARK_PAPER);
      const secondary = contrastRatio(darkPalette.text!.secondary!, DARK_PAPER, DARK_PAPER);
      expect(secondary).toBeLessThan(primary);
    });

    // The palette-independent anchor: pure black on pure white is
    // exactly 21:1 by definition, so this pins the calculator rather than the
    // theme and stays valid through any palette change.
    it('black on white is exactly 21:1 regardless of palette', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    });
  });
});
