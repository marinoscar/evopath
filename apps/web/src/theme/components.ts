import type { Components, Theme } from '@mui/material/styles';

/**
 * Theme-level component overrides for the Tidal Teal theme, mirrored from the
 * design studio mock-up (`docs/design/color-studio/studio.jsx`, `buildTheme`).
 *
 * ONE set for both colour schemes. Every colour is read through
 * `theme.vars.palette.*` inside a `({ theme }) =>` callback, so each rule
 * resolves to a CSS custom property (`var(--mui-palette-…)`) that the active
 * `.light` / `.dark` class on `<html>` flips — not to a hex baked in at theme
 * creation, which would be the light value in both schemes. Nothing in here
 * branches on `palette.mode`.
 */
export const componentOverrides: Components<Theme> = {
  MuiCssBaseline: {},
  MuiPaper: {
    defaultProps: { elevation: 0 },
  },
  MuiCard: {
    defaultProps: { variant: 'outlined' },
  },
  MuiAppBar: {
    defaultProps: { color: 'default', elevation: 0 },
    styleOverrides: {
      root: ({ theme }) => ({
        backgroundColor: theme.vars.palette.background.paper,
        color: theme.vars.palette.text.primary,
        boxShadow: 'none',
        borderBottom: `1px solid ${theme.vars.palette.divider}`,
      }),
    },
  },
  MuiButton: {
    styleOverrides: {
      root: {
        borderRadius: 999,
        paddingInline: 18,
      },
      outlined: ({ theme }) => ({
        borderColor: theme.vars.palette.outline,
      }),
    },
  },
  MuiChip: {
    styleOverrides: {
      root: { fontWeight: 500 },
      outlined: ({ theme }) => ({
        borderColor: theme.vars.palette.outline,
      }),
    },
  },
  MuiTab: {
    styleOverrides: {
      root: {
        textTransform: 'none',
        fontWeight: 600,
        minHeight: 44,
      },
    },
  },
  MuiToggleButton: {
    styleOverrides: {
      root: ({ theme }) => ({
        textTransform: 'none',
        fontWeight: 600,
        borderColor: theme.vars.palette.outline,
      }),
    },
  },
  MuiLinearProgress: {
    styleOverrides: {
      root: ({ theme }) => ({
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.vars.palette.surface.container2,
      }),
      bar: { borderRadius: 3 },
    },
  },
  MuiTableCell: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderColor: theme.vars.palette.divider,
      }),
    },
  },
  MuiAlert: {
    styleOverrides: {
      root: { borderRadius: 12 },
    },
  },
  MuiFab: {
    styleOverrides: {
      root: { boxShadow: 'none', borderRadius: 16 },
    },
  },
  MuiOutlinedInput: {
    styleOverrides: {
      notchedOutline: ({ theme }) => ({
        borderColor: theme.vars.palette.outline,
      }),
    },
  },
};
