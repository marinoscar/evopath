/* EvoPath Color Studio — four candidate colour schemes rendered with Material UI (UMD v5). */
const {
  createTheme, ThemeProvider, ScopedCssBaseline, alpha,
  Box, Stack, Paper, Card, CardContent, Typography, AppBar, Toolbar, IconButton, Avatar, Divider,
  Button, Chip, Tabs, Tab, Alert, AlertTitle, Switch, TextField, MenuItem, LinearProgress, CircularProgress,
  BottomNavigation, BottomNavigationAction, Badge, Fab, Checkbox, Radio, FormControlLabel,
  Table, TableHead, TableRow, TableCell, TableBody, ToggleButtonGroup, ToggleButton, SvgIcon, Tooltip, List, ListItemButton, ListItemIcon, ListItemText,
} = MaterialUI;
const { useState, useMemo, useEffect, useRef, useContext, createContext } = React;
const Compact = createContext(false);
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return w;
}

/* ------------------------------------------------------------------ icons */
const P = {
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  play: 'M8 5v14l11-7z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  place: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  fitness: 'M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z',
  error: 'M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
  warn: 'M12 5.99L19.53 19H4.47L12 5.99M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  check: 'M16.59 7.58L10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
  up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  today: 'M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  battery: 'M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4zM11 20v-5.5H9L13 7v5.5h2L11 20z',
  chart: 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',
  dash: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  sparkle: 'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z',
  bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  scale: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 2a7 7 0 110 14 7 7 0 010-14zm-1 3h2v5h-2z',
  restaurant: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  camera: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z',
};
const Ic = ({ d, ...rest }) => <SvgIcon {...rest}><path d={P[d]} /></SvgIcon>;

/* ---------------------------------------------------------------- options */
const STATUS_LIGHT = { success: { main: '#1B7F4A' }, warning: { main: '#9C5A00' }, error: { main: '#B42318' }, info: { main: '#0B6AA6' } };
const STATUS_DARK = { success: { main: '#62C68E' }, warning: { main: '#E6B452' }, error: { main: '#F28B82' }, info: { main: '#7DB9EE' } };

const OPTIONS = [
  {
    id: 'tidal', name: 'Tidal Teal', tag: 'Recommended',
    brief: 'Evolves the current brand teal into a complete tonal system. Calm and clinical, with coral reserved for effort and violet reserved for AI.',
    light: {
      primary: { main: '#0F766E', light: '#14A08F', dark: '#0B5A54', contrastText: '#FFFFFF', container: '#CCF0EA', onContainer: '#0A3F3B' },
      secondary: { main: '#B8441F', light: '#D9603A', dark: '#8F3316', contrastText: '#FFFFFF', container: '#FBE1D6', onContainer: '#5A1E0A' },
      tertiary: { main: '#4F49C4', contrastText: '#FFFFFF' },
      ...STATUS_LIGHT,
      bg: '#F2F7F6', paper: '#FFFFFF', c1: '#E7EFEE', c2: '#DBE6E5', divider: '#D0DDDB', outline: '#6B8481',
      text: '#0E1F1D', text2: '#4A605D',
      chart: ['#0d9488', '#d97706', '#4f46e5', '#db2777', '#0284c7', '#65a30d'],
    },
    dark: {
      primary: { main: '#4FCDBC', light: '#8BE3D6', dark: '#2BA897', contrastText: '#04302B', container: '#0F4F49', onContainer: '#B6F0E7' },
      secondary: { main: '#F0906E', light: '#F7B59C', dark: '#D96F4A', contrastText: '#3A1407', container: '#5C2A17', onContainer: '#FBD9CB' },
      tertiary: { main: '#B4ABF4', contrastText: '#1E1A5C' },
      ...STATUS_DARK,
      bg: '#0B1413', paper: '#122020', c1: '#192B2A', c2: '#213634', divider: '#2A423F', outline: '#7E9794',
      text: '#E3EEEC', text2: '#9CB2AE',
      chart: ['#1fa396', '#c98500', '#9085e9', '#d55181', '#3987e5', '#6f9a1a'],
    },
  },
  {
    id: 'indigo', name: 'Indigo Clinic', tag: 'Alternative',
    brief: 'Lab-grade indigo with cyan data accents. Reads like a medical record viewer; the closest to Apple Health and Oura territory.',
    light: {
      primary: { main: '#4338CA', light: '#6366F1', dark: '#3730A3', contrastText: '#FFFFFF', container: '#E1E1FB', onContainer: '#1E1B5E' },
      secondary: { main: '#0E7490', light: '#1F97B5', dark: '#0A5568', contrastText: '#FFFFFF', container: '#CDF1F9', onContainer: '#063845' },
      tertiary: { main: '#C2410C', contrastText: '#FFFFFF' },
      ...STATUS_LIGHT,
      bg: '#F4F5FB', paper: '#FFFFFF', c1: '#EAECF7', c2: '#DFE2F2', divider: '#D3D7EA', outline: '#6E7495',
      text: '#121633', text2: '#4B5173',
      chart: ['#4f46e5', '#eb6834', '#0891b2', '#d99a00', '#e0479a', '#008300'],
    },
    dark: {
      primary: { main: '#A5A8F6', light: '#C7C8FB', dark: '#8083EC', contrastText: '#14163F', container: '#33358A', onContainer: '#E1E1FB' },
      secondary: { main: '#5CD3E6', light: '#93E4F0', dark: '#2FB4CB', contrastText: '#03323B', container: '#0C4A58', onContainer: '#C8F2FA' },
      tertiary: { main: '#F29572', contrastText: '#3F1407' },
      ...STATUS_DARK,
      bg: '#0B1020', paper: '#121936', c1: '#1A2345', c2: '#222D55', divider: '#2C3861', outline: '#8089B0',
      text: '#E6E8F7', text2: '#9FA6CB',
      chart: ['#9085e9', '#d95926', '#1f9ea8', '#c98500', '#d55181', '#008300'],
    },
  },
  {
    id: 'evergreen', name: 'Evergreen Path', tag: 'Alternative',
    brief: 'Pine green on warm stone neutrals. Leans into growth and the path metaphor; the warmest of the four, and the one where "good" status and brand share a hue.',
    light: {
      primary: { main: '#1E6E47', light: '#3B9066', dark: '#145033', contrastText: '#FFFFFF', container: '#D2EFDC', onContainer: '#0A3A22' },
      secondary: { main: '#8F6410', light: '#B3851F', dark: '#6A4909', contrastText: '#FFFFFF', container: '#F6E8C3', onContainer: '#4A3205' },
      tertiary: { main: '#7A3E8E', contrastText: '#FFFFFF' },
      ...STATUS_LIGHT,
      bg: '#F6F5F0', paper: '#FFFDF9', c1: '#ECEAE2', c2: '#E1DED4', divider: '#D6D2C6', outline: '#7B7A70',
      text: '#1B1C17', text2: '#55594E',
      chart: ['#1f8a4c', '#7e3f8f', '#b7791f', '#0369a1', '#c2410c', '#0e8fa3'],
    },
    dark: {
      primary: { main: '#7FD39B', light: '#A9E6BD', dark: '#55B57A', contrastText: '#06301A', container: '#1C5236', onContainer: '#C9F0D6' },
      secondary: { main: '#E3B657', light: '#EFCE8A', dark: '#C79A3A', contrastText: '#3B2800', container: '#5B4310', onContainer: '#F8E6B8' },
      tertiary: { main: '#D1A3E0', contrastText: '#3E1A4B' },
      ...STATUS_DARK,
      bg: '#101410', paper: '#171C17', c1: '#1F261F', c2: '#283028', divider: '#333D33', outline: '#8A9389',
      text: '#E8EBE3', text2: '#A4AC9E',
      chart: ['#3a9f62', '#9f80cf', '#c98500', '#3987e5', '#d95926', '#1f9ea8'],
    },
  },
  {
    id: 'graphite', name: 'Graphite Pulse', tag: 'Counterpoint',
    brief: 'Near-black with signal orange. Performance-tracker energy in the Whoop and Strava mould; the loudest option, strongest on training screens and hardest on long reading.',
    light: {
      primary: { main: '#BA3E0A', light: '#E25A1E', dark: '#8C2E06', contrastText: '#FFFFFF', container: '#FFE1D2', onContainer: '#5A1D03' },
      secondary: { main: '#0B6AA6', light: '#2A88C4', dark: '#084E7A', contrastText: '#FFFFFF', container: '#D5EBFA', onContainer: '#063450' },
      tertiary: { main: '#4D7C0F', contrastText: '#FFFFFF' },
      ...STATUS_LIGHT,
      bg: '#F5F5F4', paper: '#FFFFFF', c1: '#ECECEA', c2: '#E1E1DE', divider: '#D4D4D0', outline: '#73736F',
      text: '#141414', text2: '#50504E',
      chart: ['#ea580c', '#0284c7', '#65a30d', '#db2777', '#7c3aed', '#0d9488'],
    },
    dark: {
      primary: { main: '#FF8A4C', light: '#FFB088', dark: '#F26A2A', contrastText: '#2A1104', container: '#6B2B0C', onContainer: '#FFDCCB' },
      secondary: { main: '#6FB9F0', light: '#A2D2F7', dark: '#4397DC', contrastText: '#05283F', container: '#0F4467', onContainer: '#D1E9FA' },
      tertiary: { main: '#A6D45E', contrastText: '#1F3300' },
      ...STATUS_DARK,
      bg: '#0B0B0C', paper: '#151517', c1: '#1E1E21', c2: '#27272B', divider: '#333338', outline: '#85858B',
      text: '#ECECEC', text2: '#A3A3A8',
      chart: ['#d95926', '#3987e5', '#6a9a1f', '#d55181', '#9085e9', '#1f9e92'],
    },
  },
];

/* ------------------------------------------------------------- contrast */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
function contrast(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
const fmtRatio = (r) => `${r.toFixed(1)}:1`;

/* --------------------------------------------------------------- theme */
function buildTheme(opt, mode) {
  const t = opt[mode];
  const base = createTheme({
    palette: {
      mode,
      primary: { main: t.primary.main, light: t.primary.light, dark: t.primary.dark, contrastText: t.primary.contrastText },
      secondary: { main: t.secondary.main, light: t.secondary.light, dark: t.secondary.dark, contrastText: t.secondary.contrastText },
      success: t.success, warning: t.warning, error: t.error, info: t.info,
      background: { default: t.bg, paper: t.paper },
      text: { primary: t.text, secondary: t.text2 },
      divider: t.divider,
      action: {
        hover: alpha(t.text, 0.06),
        selected: alpha(t.primary.main, mode === 'dark' ? 0.18 : 0.12),
        selectedOpacity: mode === 'dark' ? 0.18 : 0.12,
      },
    },
    typography: {
      fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
      h4: { fontWeight: 700, letterSpacing: '-0.01em' },
      h5: { fontWeight: 650, letterSpacing: '-0.01em' },
      h6: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 600, textTransform: 'none' },
      overline: { fontWeight: 600, letterSpacing: '0.08em' },
    },
    shape: { borderRadius: 12 },
  });
  base.palette.tertiary = base.palette.augmentColor({ color: t.tertiary, name: 'tertiary' });
  base.custom = { ...t };
  return createTheme(base, {
    components: {
      MuiPaper: { defaultProps: { elevation: 0 } },
      MuiCard: { defaultProps: { variant: 'outlined' }, styleOverrides: { root: { borderColor: t.divider } } },
      MuiAppBar: { defaultProps: { color: 'default', elevation: 0 }, styleOverrides: { root: { backgroundColor: t.paper, color: t.text, borderBottom: `1px solid ${t.divider}` } } },
      MuiButton: { styleOverrides: { root: { borderRadius: 999, paddingInline: 18 }, outlined: { borderColor: t.outline } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 }, outlined: { borderColor: t.outline } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, minHeight: 44 } } },
      MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, borderColor: t.outline } } },
      MuiLinearProgress: { styleOverrides: { root: { height: 6, borderRadius: 3, backgroundColor: t.c2 }, bar: { borderRadius: 3 } } },
      MuiTableCell: { styleOverrides: { root: { borderColor: t.divider } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 12 } } },
      MuiFab: { styleOverrides: { root: { boxShadow: 'none', borderRadius: 16 } } },
      MuiOutlinedInput: { styleOverrides: { notchedOutline: { borderColor: t.outline } } },
    },
  });
}

/* ----------------------------------------------------------- fake data */
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function wave(n, seed, base, amp, noise = 0.3) {
  const r = seeded(seed); return Array.from({ length: n }, (_, i) => +(base + amp * Math.sin(i / n * Math.PI * 2.3 + seed) + (r() - 0.5) * amp * noise).toFixed(2));
}
const DATA = {
  weight: wave(28, 7, 209.6, 0.9).map((v, i) => +(v - i * 0.035).toFixed(1)),
  weightScale: wave(28, 9, 210.1, 0.6).map((v, i) => +(v - i * 0.03).toFixed(1)),
  req: wave(24, 3, 214, 40, 0.5),
  errRate: wave(24, 5, 2.1, 1.2, 0.6).map((v, i) => i > 17 ? +(v + 3.6 + (i - 17) * 0.5).toFixed(2) : v),
  p95: wave(24, 11, 0.9, 0.25, 0.4).map((v, i) => i > 18 ? +(v + 1.0).toFixed(2) : v),
  logs: wave(24, 13, 22, 10, 0.8).map((v) => Math.max(2, Math.round(v))),
  warns: wave(24, 17, 60, 25, 0.8).map((v) => Math.max(5, Math.round(v))),
  heap: wave(24, 19, 160, 12, 0.3),
  lag: wave(24, 23, 30, 14, 0.7),
};
const TIMES = Array.from({ length: 24 }, (_, i) => { const h = 9 + Math.floor((i * 5 + 50) / 60), m = (i * 5 + 50) % 60; return `${h}:${String(m).padStart(2, '0')}`; });

/* ------------------------------------------------------------- charts */
function Spark({ data, color, h = 36, fill = true }) {
  const w = 160, min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - 3 - (v - min) / span * (h - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-hidden style={{ display: 'block' }}>
      {fill && <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity="0.12" />}
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function useHover() {
  const [i, setI] = useState(null);
  return { i, bind: (n, W, L, R) => ({
    onMouseMove: (e) => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * W; setI(Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - R) * (n - 1))))); },
    onMouseLeave: () => setI(null),
  }) };
}

function LineChart({ series, labels, unit = '', height = 220, yFmt = (v) => v }) {
  const theme = MaterialUI.useTheme();
  const ref = useRef(null); const mw = useWidth(ref);
  const W = Math.max(280, Math.round(mw) || 640), H = height, L = 46, R = 16, T = 14, B = 28;
  const all = series.flatMap((s) => s.data).filter((v) => v != null);
  const min = Math.min(...all), max = Math.max(...all), pad = (max - min) * 0.15 || 1;
  const y0 = min - pad, y1 = max + pad;
  const x = (i) => L + i / (labels.length - 1) * (W - L - R);
  const y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((k) => y0 + (y1 - y0) * k / 3);
  const hv = useHover();
  const tx = theme.palette.text.secondary, grid = theme.palette.divider;
  return (
    <Box ref={ref} sx={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', fontFamily: 'inherit', maxWidth: '100%' }} {...hv.bind(labels.length, W, L, R)}>
        {ticks.map((t, k) => <g key={k}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={grid} strokeWidth="1" /><text x={L - 8} y={y(t) + 4} fontSize="11" textAnchor="end" fill={tx}>{yFmt(t)}</text></g>)}
        {labels.map((lb, i) => (i % Math.ceil(labels.length / 6) === 0) && <text key={i} x={x(i)} y={H - 8} fontSize="11" textAnchor="middle" fill={tx}>{lb}</text>)}
        {series.map((s, si) => {
          const d = s.data.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reduce((acc, p, i, arr) => p == null ? acc : acc + (i === 0 || arr[i - 1] == null ? ' M' : ' L') + p, '');
          const li = s.data.length - 1;
          return (
            <g key={si}>
              {s.area && <path d={`${d} L${x(li)},${y(y0)} L${x(0)},${y(y0)} Z`} fill={s.color} opacity="0.1" />}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeDasharray={s.dash ? '5 4' : undefined} />
              <circle cx={x(li)} cy={y(s.data[li])} r="4" fill={s.color} stroke={theme.palette.background.paper} strokeWidth="2" />
            </g>
          );
        })}
        {hv.i != null && <line x1={x(hv.i)} x2={x(hv.i)} y1={T} y2={H - B} stroke={tx} strokeWidth="1" strokeDasharray="3 3" />}
        {hv.i != null && series.map((s, si) => s.data[hv.i] != null && <circle key={si} cx={x(hv.i)} cy={y(s.data[hv.i])} r="4.5" fill={s.color} stroke={theme.palette.background.paper} strokeWidth="2" />)}
      </svg>
      {hv.i != null && (
        <Paper variant="outlined" sx={{ position: 'absolute', top: 6, left: `calc(${x(hv.i) / W * 100}% + 10px)`, transform: hv.i > labels.length * 0.6 ? 'translateX(calc(-100% - 20px))' : 'none', px: 1.25, py: 0.75, pointerEvents: 'none', bgcolor: 'background.paper', minWidth: 120 }}>
          <Typography variant="caption" color="text.secondary" display="block">{labels[hv.i]}</Typography>
          {series.map((s, si) => s.data[hv.i] != null && (
            <Stack key={si} direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Stack direction="row" spacing={0.75} alignItems="center"><Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: s.color }} /><Typography variant="caption">{s.name}</Typography></Stack>
              <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{s.data[hv.i]}{unit}</Typography>
            </Stack>
          ))}
        </Paper>
      )}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        {series.map((s) => <Stack key={s.name} direction="row" spacing={0.75} alignItems="center"><Box sx={{ width: 14, height: 3, borderRadius: 2, bgcolor: s.color }} /><Typography variant="caption" color="text.secondary">{s.name}</Typography></Stack>)}
      </Stack>
    </Box>
  );
}

function StackedBars({ stacks, labels, height = 200, line }) {
  const theme = MaterialUI.useTheme();
  const ref = useRef(null); const mw = useWidth(ref);
  const W = Math.max(280, Math.round(mw) || 640), H = height, L = 40, R = 16, T = 10, B = 28;
  const totals = labels.map((_, i) => stacks.reduce((a, s) => a + s.data[i], 0));
  const max = Math.max(...totals) * 1.1;
  const bw = (W - L - R) / labels.length;
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const hv = useHover();
  const tx = theme.palette.text.secondary, grid = theme.palette.divider, gap = theme.palette.background.paper;
  return (
    <Box ref={ref} sx={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }} {...hv.bind(labels.length, W, L, R)}>
        {[0, 1, 2, 3].map((k) => <g key={k}><line x1={L} x2={W - R} y1={y(max * k / 3)} y2={y(max * k / 3)} stroke={grid} /><text x={L - 8} y={y(max * k / 3) + 4} fontSize="11" textAnchor="end" fill={tx}>{Math.round(max * k / 3)}</text></g>)}
        {labels.map((lb, i) => {
          let acc = 0;
          return (
            <g key={i} opacity={hv.i == null || hv.i === i ? 1 : 0.55}>
              {stacks.map((s, si) => { const v = s.data[i]; const top = y(acc + v), bot = y(acc); acc += v; return <rect key={si} x={L + i * bw + 2} width={bw - 4} y={top} height={Math.max(0, bot - top)} fill={s.color} stroke={gap} strokeWidth="1" rx={si === stacks.length - 1 ? 2 : 0} />; })}
              {i % 4 === 0 && <text x={L + i * bw + bw / 2} y={H - 8} fontSize="11" textAnchor="middle" fill={tx}>{lb}</text>}
            </g>
          );
        })}
        {line && (() => { const lmax = Math.max(...line.data) * 1.1; const ly = (v) => T + (1 - v / lmax) * (H - T - B); const d = line.data.map((v, i) => `${i ? 'L' : 'M'}${(L + i * bw + bw / 2).toFixed(1)},${ly(v).toFixed(1)}`).join(' '); return <path d={d} fill="none" stroke={theme.palette.text.primary} strokeWidth="1.5" strokeDasharray="4 3" />; })()}
      </svg>
      {hv.i != null && (
        <Paper variant="outlined" sx={{ position: 'absolute', top: 4, left: `calc(${(L + hv.i * bw) / W * 100}% + 12px)`, transform: hv.i > labels.length * 0.6 ? 'translateX(calc(-100% - 24px))' : 'none', px: 1.25, py: 0.75, pointerEvents: 'none', minWidth: 130 }}>
          <Typography variant="caption" color="text.secondary" display="block">{labels[hv.i]}</Typography>
          {stacks.map((s) => <Stack key={s.name} direction="row" justifyContent="space-between" spacing={1.5}><Stack direction="row" spacing={0.75} alignItems="center"><Box sx={{ width: 8, height: 8, borderRadius: 1, bgcolor: s.color }} /><Typography variant="caption">{s.name}</Typography></Stack><Typography variant="caption" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{s.data[hv.i]}</Typography></Stack>)}
          {line && <Stack direction="row" justifyContent="space-between" spacing={1.5}><Typography variant="caption">{line.name}</Typography><Typography variant="caption" sx={{ fontWeight: 600 }}>{line.data[hv.i]} ms</Typography></Stack>}
        </Paper>
      )}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        {stacks.map((s) => <Stack key={s.name} direction="row" spacing={0.75} alignItems="center"><Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: s.color }} /><Typography variant="caption" color="text.secondary">{s.name}</Typography></Stack>)}
        {line && <Stack direction="row" spacing={0.75} alignItems="center"><Box sx={{ width: 14, height: 0, borderTop: '2px dashed', borderColor: 'text.primary' }} /><Typography variant="caption" color="text.secondary">{line.name}</Typography></Stack>}
      </Stack>
    </Box>
  );
}

function Ring({ value, size = 84, color = 'primary.main', label, caption }) {
  return (
    <Stack alignItems="center" spacing={0.5}>
      <Box sx={{ position: 'relative', width: size, height: size }}>
        <CircularProgress variant="determinate" value={100} size={size} thickness={4} sx={{ color: 'divider', position: 'absolute' }} />
        <CircularProgress variant="determinate" value={value} size={size} thickness={4} sx={{ color, position: 'absolute', '& .MuiCircularProgress-circle': { strokeLinecap: 'round' } }} />
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{label}</Typography></Box>
      </Box>
      {caption && <Typography variant="caption" color="text.secondary">{caption}</Typography>}
    </Stack>
  );
}

/* ---------------------------------------------------------------- shell */
function Logo() {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box sx={{ width: 28, height: 28, borderRadius: 2, bgcolor: 'primary.main', display: 'grid', placeItems: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M4 17c3-1 4-7 8-7s5 6 8 2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ color: 'var(--on-primary)' }} /></svg>
      </Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>EvoPath</Typography>
    </Stack>
  );
}

function Rail({ active, items }) {
  return (
    <Box component="nav" aria-label="Destinations" sx={{ width: 76, flexShrink: 0, borderRight: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', py: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
      {items.map((it) => {
        const on = it.key === active;
        return (
          <Box key={it.key} sx={{ width: 64, py: 0.75, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25, color: on ? 'text.primary' : 'text.secondary', cursor: 'pointer' }}>
            <Box sx={{ width: 48, height: 30, borderRadius: 999, display: 'grid', placeItems: 'center', bgcolor: on ? 'var(--primary-container)' : 'transparent', color: on ? 'var(--on-primary-container)' : 'inherit' }}>
              <Ic d={it.icon} fontSize="small" />
            </Box>
            <Typography variant="caption" sx={{ fontWeight: on ? 600 : 500, fontSize: 11 }}>{it.label}</Typography>
          </Box>
        );
      })}
    </Box>
  );
}

const LIB = [
  { key: 'today', label: 'Today', icon: 'today' }, { key: 'train', label: 'Train', icon: 'fitness' },
  { key: 'health', label: 'Health', icon: 'heart' }, { key: 'nutrition', label: 'Eat', icon: 'restaurant' }, { key: 'gyms', label: 'Gyms', icon: 'place' },
];
const ADMIN = [
  { key: 'doctor', label: 'Doctor', icon: 'check' }, { key: 'telemetry', label: 'Telemetry', icon: 'dash' }, { key: 'users', label: 'Users', icon: 'bell' }, { key: 'settings', label: 'Settings', icon: 'settings' },
];

function Shell({ children, active, admin, title }) {
  const compact = useContext(Compact);
  const items = admin ? ADMIN : LIB;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 560 }}>
      <AppBar position="static">
        <Toolbar variant="dense" sx={{ gap: 1, minHeight: 56 }}>
          <Logo />
          {admin && <Chip size="small" label="Console" variant="outlined" sx={{ ml: 1 }} />}
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" aria-label="Notifications"><Badge color="secondary" variant="dot"><Ic d="bell" fontSize="small" /></Badge></IconButton>
          <IconButton size="small" aria-label="Settings"><Ic d="settings" fontSize="small" /></IconButton>
          <Avatar sx={{ width: 30, height: 30, fontSize: 13, bgcolor: 'var(--primary-container)', color: 'var(--on-primary-container)', fontWeight: 600 }}>OM</Avatar>
        </Toolbar>
      </AppBar>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!compact && <Rail active={active} items={items} />}
        <Box sx={{ flex: 1, minWidth: 0, p: compact ? 2 : 3 }}>{children}</Box>
      </Box>
      {compact && (
        <BottomNavigation showLabels value={Math.max(0, items.findIndex((i) => i.key === active))} sx={{ borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', '& .Mui-selected .MuiSvgIcon-root': { color: 'var(--on-primary-container)' }, '& .Mui-selected': { '& .nav-pill': { bgcolor: 'var(--primary-container)' } } }}>
          {items.slice(0, 5).map((it) => <BottomNavigationAction key={it.key} label={it.label} icon={<Box className="nav-pill" sx={{ px: 1.5, py: 0.25, borderRadius: 999, display: 'grid', placeItems: 'center' }}><Ic d={it.icon} fontSize="small" /></Box>} />)}
        </BottomNavigation>
      )}
    </Box>
  );
}

/* --------------------------------------------------------------- screens */
const Prov = ({ label }) => <Chip size="small" variant="outlined" label={label} sx={{ height: 22, fontSize: 11 }} />;

function Delta({ dir, text, tone }) {
  const color = tone === 'good' ? 'success.main' : tone === 'bad' ? 'error.main' : 'text.secondary';
  return <Typography variant="caption" sx={{ color, display: 'inline-flex', alignItems: 'center', gap: 0.25, fontWeight: 600 }}>{dir === 'up' ? <Ic d="up" sx={{ fontSize: 14 }} /> : dir === 'down' ? <Ic d="down" sx={{ fontSize: 14 }} /> : <span>=</span>}{text}</Typography>;
}

function TodayScreen() {
  const theme = MaterialUI.useTheme();
  return (
    <Shell active="today">
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1} sx={{ mb: 2.5 }}>
        <Box><Typography variant="h4" component="h1">Today</Typography><Typography color="text.secondary">Thursday, October 1 · Hello, Oscar</Typography></Box>
        <Button variant="outlined" startIcon={<Ic d="camera" />}>Log a meal</Button>
      </Stack>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <Card sx={{ gridColumn: '1 / -1', minWidth: 0 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><Ic d="fitness" fontSize="small" color="primary" /><Typography variant="h6">Today's workout</Typography><Chip size="small" label="Push · Week 6 of 12" sx={{ ml: 'auto', bgcolor: 'var(--primary-container)', color: 'var(--on-primary-container)' }} /></Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Home Gym · 5 exercises · about 55 min · adjusted for yesterday's soreness</Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <Button variant="contained" startIcon={<Ic d="play" />}>Start workout</Button>
              <Button variant="text" color="secondary" startIcon={<Ic d="bolt" />}>Only 30 minutes</Button>
            </Stack>
            <Divider sx={{ mb: 1.5 }} />
            <Typography variant="subtitle2" gutterBottom>Last session · Push day · Yesterday</Typography>
            <Stack spacing={0.5}>
              {[['Bench Press', '198.4 lb × 5', '+2.2 lb', 'good'], ['Overhead Press', '121.3 lb × 8', 'PR', 'good'], ['Incline Dumbbell Press', '66.1 lb × 10', 'same', 'neutral']].map(([n, s, d, t]) => (
                <Stack key={n} direction="row" spacing={1} alignItems="baseline"><Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{n}</Typography><Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{s}</Typography><Delta dir={t === 'good' ? 'up' : 'flat'} text={d} tone={t} /></Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 0 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}><Ic d="battery" fontSize="small" color="primary" /><Typography variant="h6">Readiness</Typography></Stack>
            <Stack direction="row" spacing={2} alignItems="center">
              <Ring value={72} label="72" caption="Ready" />
              <Stack spacing={0.75} sx={{ flex: 1 }}>
                {[['Sleep', 7.4, 'h', 82], ['Energy', 4, '/5', 80], ['Soreness', 2, '/5', 40], ['Stress', 3, '/5', 60]].map(([k, v, u, p]) => (
                  <Box key={k}><Stack direction="row" justifyContent="space-between"><Typography variant="caption" color="text.secondary">{k}</Typography><Typography variant="caption" sx={{ fontWeight: 600 }}>{v}{u}</Typography></Stack><LinearProgress variant="determinate" value={p} sx={{ height: 4 }} /></Box>
                ))}
              </Stack>
            </Stack>
            <Button size="small" sx={{ mt: 1.5 }}>Edit check-in</Button>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 0 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}><Ic d="scale" fontSize="small" color="primary" /><Typography variant="h6">Body snapshot</Typography></Stack>
            <Stack spacing={1.25}>
              {[['Weight', '208.4', 'lb', 'down', '−0.5 lb', 'good', 'Smart scale'], ['Body fat', '27.8', '%', 'down', '−0.3 pts', 'good', 'Smart scale'], ['Waist', '34.0', 'in', 'flat', '3 d ago', 'neutral', 'Tape']].map(([k, v, u, d, t, tone, src]) => (
                <Stack key={k} direction="row" alignItems="baseline" spacing={1} sx={{ minWidth: 0 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ width: 64, flexShrink: 0 }}>{k}</Typography>
                  <Typography variant="h6" noWrap sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}<Typography component="span" variant="caption" color="text.secondary"> {u}</Typography></Typography>
                  <Box sx={{ whiteSpace: 'nowrap' }}><Delta dir={d} text={t} tone={tone} /></Box>
                  <Box sx={{ ml: 'auto', flexShrink: 0 }}><Prov label={src} /></Box>
                </Stack>
              ))}
            </Stack>
            <Box sx={{ mt: 1.5 }}><Spark data={DATA.weight} color={theme.custom.chart[0]} h={40} /></Box>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 0, bgcolor: 'var(--surface-1)' }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><Ic d="sparkle" fontSize="small" sx={{ color: 'tertiary.main' }} /><Typography variant="h6">Coach</Typography><Chip size="small" label="AI · proposed" variant="outlined" sx={{ ml: 'auto', color: 'tertiary.main', borderColor: 'tertiary.main' }} /></Stack>
            <Typography variant="body2" sx={{ mb: 1.5 }}>Protein landed at 142 g against a 170 g target for three days running. Yesterday's bench moved up, so recovery is fine. Suggest adding a 30 g serving at lunch this week.</Typography>
            <Stack direction="row" spacing={1}><Button size="small" variant="contained" color="tertiary">Apply to plan</Button><Button size="small">Why this?</Button></Stack>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 0 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><Ic d="restaurant" fontSize="small" color="primary" /><Typography variant="h6">Nutrition</Typography></Stack>
            <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-around">
              <Ring value={64} size={72} label="1,420" caption="of 2,200 kcal" />
              <Ring value={56} size={72} label="96 g" caption="of 170 g protein" color="secondary.main" />
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Shell>
  );
}

function HealthScreen() {
  const theme = MaterialUI.useTheme();
  const labels = Array.from({ length: 28 }, (_, i) => `Sep ${i + 3}`);
  return (
    <Shell active="health">
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1} sx={{ mb: 2.5 }}>
        <Box><Typography variant="h4" component="h1">Health</Typography><Typography color="text.secondary">Your body and how you feel</Typography></Box>
        <Button variant="contained" startIcon={<Ic d="add" />}>Log measurement</Button>
      </Stack>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', mb: 2 }}>
        {[['Weight', '208.4', 'lb', 'Today', '−0.5 lb', 'good', 'Smart scale'], ['Body fat', '27.8', '%', 'Today', '−0.3 pts', 'good', 'Smart scale'], ['Blood pressure', '128/84', 'mmHg', 'Yesterday', 'Elevated', 'bad', 'BP cuff'], ['Resting HR', '58', 'bpm', 'Yesterday', 'no change', 'neutral', 'Watch']].map(([k, v, u, when, d, tone, src]) => (
          <Card key={k} sx={{ minWidth: 0 }}><CardContent sx={{ pb: '16px !important' }}>
            <Typography variant="caption" color="text.secondary" component="h3">{k}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}<Typography component="span" variant="body2" color="text.secondary"> {u}</Typography></Typography>
            <Stack direction="row" spacing={1} alignItems="center"><Typography variant="caption" color="text.secondary">{when}</Typography><Delta dir={tone === 'good' ? 'down' : 'flat'} text={d} tone={tone} /></Stack>
            <Box sx={{ mt: 1 }}><Prov label={src} /></Box>
          </CardContent></Card>
        ))}
      </Box>
      <Card sx={{ mb: 2 }}><CardContent>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <Typography variant="h6">Goal · Body fat 27.8% → 22%</Typography>
          <Chip size="small" color="success" variant="outlined" label="On track" icon={<Ic d="check" />} />
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>Target: March 2027 · preserve lean mass</Typography>
        </Stack>
        <LinearProgress variant="determinate" value={38} sx={{ height: 8 }} />
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}><Typography variant="caption" color="text.secondary">Started 31.4%</Typography><Typography variant="caption" color="text.secondary">38% of the way</Typography></Stack>
      </CardContent></Card>
      <Card><CardContent>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <Typography variant="h6">Trend</Typography>
          <TextField select size="small" value="Weight" label="Metric" sx={{ minWidth: 150 }}><MenuItem value="Weight">Weight</MenuItem></TextField>
          <ToggleButtonGroup size="small" exclusive value="90"><ToggleButton value="30">30 d</ToggleButton><ToggleButton value="90">90 d</ToggleButton><ToggleButton value="180">180 d</ToggleButton></ToggleButtonGroup>
        </Stack>
        <Alert severity="info" icon={<Ic d="info" fontSize="inherit" />} sx={{ mb: 1.5, py: 0 }}>This range mixes measurement methods (Scale, Smart scale). Values from different methods are not directly comparable.</Alert>
        <LineChart labels={labels} unit=" lb" yFmt={(v) => v.toFixed(1)} series={[{ name: 'Smart scale', data: DATA.weight, color: theme.custom.chart[0], area: true }, { name: 'Scale', data: DATA.weightScale.map((v, i) => i % 3 === 0 ? v : null).map((v, i, a) => v ?? (i > 0 && i < a.length - 1 ? +((DATA.weightScale[i - 1] + DATA.weightScale[i + 1]) / 2).toFixed(1) : v)), color: theme.custom.chart[1], dash: true }]} />
      </CardContent></Card>
    </Shell>
  );
}

function Tile({ label, value, unit, delta, tone, data, color }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="caption" color="text.secondary" noWrap component="h3">{label}</Typography>
      <Stack direction="row" spacing={0.5} alignItems="baseline"><Typography variant="h5" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>{unit && <Typography variant="body2" color="text.secondary">{unit}</Typography>}</Stack>
      {delta && <Delta dir={delta[0]} text={`${delta[1]} vs prev`} tone={tone} />}
      {data && <Box sx={{ mt: 'auto', pt: 1 }}><Spark data={data} color={color} h={32} /></Box>}
    </Paper>
  );
}

function Sev({ kind, compact }) {
  const meta = { error: ['Error', 'error', 'error'], warn: ['Warn', 'warn', 'warning'], info: ['Info', 'info', 'info'] }[kind];
  return compact
    ? <Chip size="small" variant="outlined" color={meta[2]} icon={<Ic d={meta[1]} />} label={meta[0]} />
    : <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: `${meta[2]}.main`, fontWeight: 600, fontSize: 13 }}><Ic d={meta[1]} sx={{ fontSize: 16 }} />{meta[0]}</Box>;
}

function TelemetryScreen() {
  const theme = MaterialUI.useTheme();
  const c = theme.custom.chart, p = theme.palette;
  const s2 = DATA.req.map((v) => Math.round(v * 0.86)), s3 = DATA.req.map((v) => Math.round(v * 0.05)), s4 = DATA.req.map((v) => Math.round(v * 0.06)), s5 = DATA.errRate.map((v, i) => Math.round(DATA.req[i] * v / 100));
  return (
    <Shell active="telemetry" admin>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1} sx={{ mb: 2 }}>
        <Box><Typography variant="h4" component="h1">Telemetry Dashboard</Typography><Typography color="text.secondary">See at a glance whether anything is wrong: error rate, latency, error logs and the top failing routes.</Typography></Box>
        <Button variant="outlined" size="small" startIcon={<Ic d="search" />}>Explorer</Button>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value="1h">{['15m', '1h', '6h', '24h', '7d'].map((v) => <ToggleButton key={v} value={v}>{v}</ToggleButton>)}</ToggleButtonGroup>
        <TextField select size="small" value="all" label="Service" sx={{ minWidth: 140 }}><MenuItem value="all">All services</MenuItem></TextField>
        <TextField select size="small" value="all" label="Host" sx={{ minWidth: 120 }}><MenuItem value="all">All hosts</MenuItem></TextField>
        <FormControlLabel sx={{ ml: 'auto' }} control={<Switch size="small" defaultChecked />} label={<Typography variant="body2">Auto-refresh</Typography>} />
      </Stack>
      <Alert severity="error" variant="outlined" icon={<Ic d="error" />} sx={{ mb: 2, bgcolor: alpha(p.error.main, theme.palette.mode === 'dark' ? 0.12 : 0.06), '& .MuiAlert-message': { width: '100%' } }} action={<Button color="inherit" size="small">Explain this</Button>}>
        <AlertTitle sx={{ fontWeight: 700 }}>Critical</AlertTitle>
        <Box component="ul" sx={{ m: 0, pl: 2.5, '& li': { fontSize: 13 } }}>
          <li>5xx rate 14.2% on POST /api/jobs (critical above 5%)</li>
          <li>p95 latency 2.4 s on GET /api/reports/:id</li>
          <li>38 error logs, up from 4 in the previous window</li>
          <li>Disk 91.2% full (≥ 85%) on mountpoint /</li>
        </Box>
      </Alert>
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Key indicators</Typography>
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <Tile label="Requests / min" value="214.6" unit="req/min" delta={['up', '8.3%']} tone="neutral" data={DATA.req} color={p.primary.main} />
          <Tile label="5xx rate" value="4.87" unit="%" delta={['up', '1,087%']} tone="bad" data={DATA.errRate} color={p.error.main} />
          <Tile label="p95 latency" value="1.84" unit="s" delta={['up', '767%']} tone="bad" data={DATA.p95} color={p.warning.main} />
          <Tile label="Error logs" value="38" delta={['up', '850%']} tone="bad" data={DATA.logs} color={p.error.main} />
          <Tile label="Warning logs" value="112" delta={['up', '16.7%']} tone="bad" data={DATA.warns} color={p.warning.main} />
          <Tile label="Heap used" value="179" unit="MB" delta={['up', '15.5%']} tone="neutral" data={DATA.heap} color={p.primary.main} />
          <Tile label="Event-loop delay p99" value="41" unit="ms" delta={['up', '241%']} tone="bad" data={DATA.lag} color={p.warning.main} />
          <Tile label="Last data" value="12 s ago" />
        </Box>
      </Paper>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', mb: 2 }}>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>API requests by status</Typography>
          <StackedBars labels={TIMES} stacks={[{ name: '2xx', data: s2, color: c[0] }, { name: '3xx', data: s3, color: c[4] }, { name: '4xx', data: s4, color: p.warning.main }, { name: '5xx', data: s5, color: p.error.main }]} line={{ name: 'p95 latency', data: DATA.p95.map((v) => Math.round(v * 1000)) }} />
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}><Typography variant="subtitle2">Log severity</Typography><Stack direction="row" spacing={0.5} sx={{ ml: 'auto' }}><Sev kind="error" compact /><Sev kind="warn" compact /></Stack></Stack>
          <StackedBars labels={TIMES} stacks={[{ name: 'Error', data: DATA.logs, color: p.error.main }, { name: 'Warn', data: DATA.warns, color: p.warning.main }]} />
        </Paper>
      </Box>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 0, overflowX: 'auto' }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Top failing routes</Typography>
          <Table size="small"><TableHead><TableRow><TableCell>Method</TableCell><TableCell>Route</TableCell><TableCell align="right">Requests</TableCell><TableCell align="right">5xx</TableCell><TableCell align="right">p95</TableCell></TableRow></TableHead>
            <TableBody>{[['POST', '/api/jobs', '1,842', '14.22%', '912 ms', 'bad'], ['GET', '/api/reports/:id', '611', '5.07%', '2.41 s', 'bad'], ['GET', '/api/users/:id', '4,210', '0.29%', '84 ms', ''], ['PUT', '/api/admin/telemetry/config', '14', '7.14%', '133 ms', 'bad'], ['GET', '/api/notifications', '2,980', '0%', '41 ms', '']].map((r) => (
              <TableRow key={r[1]}><TableCell><Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace' }}>{r[0]}</Typography></TableCell><TableCell sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>{r[1]}</TableCell><TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r[2]}</TableCell><TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: r[5] ? 'error.main' : 'inherit', fontWeight: r[5] ? 600 : 400 }}>{r[3]}</TableCell><TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r[4]}</TableCell></TableRow>
            ))}</TableBody></Table>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Recent events</Typography>
          <Stack divider={<Divider />} spacing={1}>
            {[['8s ago', 'error', 'my-app-api', 'Database connection refused: connect ECONNREFUSED 10.0.3.14:5432'], ['47s ago', 'warn', 'my-app-api', 'Slow query on jobs (1,204 ms)'], ['1m ago', 'error', 'my-app-worker', 'Job export.csv failed: upload to object storage timed out after 30000 ms'], ['2m ago', 'warn', 'my-app-api', 'Retrying job 8812 (attempt 2 of 3)'], ['4m ago', 'info', 'my-app-api', 'Maintenance window scheduled for 02:00 UTC']].map((e, i) => (
              <Stack key={i} direction="row" spacing={1.5} alignItems="flex-start" sx={{ pt: i ? 1 : 0 }}>
                <Typography variant="caption" color="text.secondary" sx={{ width: 52, flexShrink: 0, pt: 0.25 }}>{e[0]}</Typography>
                <Box sx={{ width: 64, flexShrink: 0 }}><Sev kind={e[1]} /></Box>
                <Box sx={{ minWidth: 0 }}><Typography variant="caption" color="text.secondary" display="block">{e[2]}</Typography><Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{e[3]}</Typography></Box>
              </Stack>
            ))}
          </Stack>
        </Paper>
      </Box>
    </Shell>
  );
}

function ComponentsScreen() {
  const [tab, setTab] = useState(0);
  return (
    <Shell active="settings" admin>
      <Typography variant="h4" component="h1" sx={{ mb: 0.5 }}>Component sheet</Typography>
      <Typography color="text.secondary" sx={{ mb: 2.5 }}>Material UI components as the theme renders them.</Typography>
      <Stack spacing={2}>
        <Card><CardContent>
          <Typography variant="overline" color="text.secondary">Buttons and chips</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ my: 1 }}>
            <Button variant="contained">Save changes</Button><Button variant="contained" color="secondary">Start workout</Button><Button variant="contained" color="tertiary" startIcon={<Ic d="sparkle" />}>Ask coach</Button>
            <Button variant="outlined">Cancel</Button><Button variant="text">Learn more</Button><Button variant="contained" color="error">Delete</Button><Button variant="contained" disabled>Disabled</Button>
            <Fab size="small" color="primary" aria-label="Add"><Ic d="add" /></Fab>
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip label="Smart scale" variant="outlined" /><Chip label="DEXA" variant="outlined" /><Chip label="AI extracted" variant="outlined" icon={<Ic d="sparkle" />} sx={{ color: 'tertiary.main', borderColor: 'tertiary.main', '& .MuiChip-icon': { color: 'inherit' } }} /><Chip label="Edited" />
            <Chip label="Active" color="primary" /><Chip label="On track" color="success" variant="outlined" icon={<Ic d="check" />} /><Chip label="Elevated" color="warning" variant="outlined" icon={<Ic d="warn" />} /><Chip label="Error" color="error" variant="outlined" icon={<Ic d="error" />} /><Chip label="Info" color="info" variant="outlined" icon={<Ic d="info" />} />
          </Stack>
        </CardContent></Card>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <Card sx={{ minWidth: 0 }}><CardContent>
            <Typography variant="overline" color="text.secondary">Inputs</Typography>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField size="small" label="Display name" defaultValue="Oscar Marin" id="f-name" />
              <TextField size="small" select label="Measurement unit" value="lb" id="f-unit"><MenuItem value="lb">Pounds (lb)</MenuItem><MenuItem value="kg">Kilograms (kg)</MenuItem></TextField>
              <TextField size="small" label="Email" defaultValue="oscar@example" error helperText="Enter a valid email address" id="f-email" />
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <FormControlLabel control={<Switch defaultChecked />} label="Dark theme" /><FormControlLabel control={<Checkbox defaultChecked />} label="Email digest" /><FormControlLabel control={<Radio checked />} label="Weekly" />
              </Stack>
            </Stack>
          </CardContent></Card>
          <Card sx={{ minWidth: 0 }}><CardContent>
            <Typography variant="overline" color="text.secondary">Navigation and feedback</Typography>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}><Tab label="Users" /><Tab label="Allowlist" /><Tab label="Sessions" /></Tabs>
            <Stack spacing={1}>
              <Alert severity="success" icon={<Ic d="check" fontSize="inherit" />}>Backup completed in 42 s.</Alert>
              <Alert severity="warning" icon={<Ic d="warn" fontSize="inherit" />}>Disk at 91% on mountpoint /.</Alert>
              <Alert severity="error" icon={<Ic d="error" fontSize="inherit" />}>Provider key rejected. Check the key in AI settings.</Alert>
              <Alert severity="info" icon={<Ic d="info" fontSize="inherit" />}>Values from different methods are not directly comparable.</Alert>
            </Stack>
            <Stack spacing={1} sx={{ mt: 2 }}>
              <LinearProgress variant="determinate" value={62} /><LinearProgress variant="determinate" value={38} color="secondary" />
              <Stack direction="row" spacing={2} alignItems="center"><CircularProgress size={24} /><Typography variant="body2" color="text.secondary">Reading your blood work…</Typography></Stack>
            </Stack>
          </CardContent></Card>
        </Box>
        <Card><CardContent>
          <Typography variant="overline" color="text.secondary">Surfaces</Typography>
          <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', mt: 1 }}>
            <Paper variant="outlined" sx={{ p: 1.5 }}><Typography variant="caption" color="text.secondary">Paper · outlined</Typography><Typography variant="body2">Default card</Typography></Paper>
            <Paper sx={{ p: 1.5, bgcolor: 'var(--surface-1)' }}><Typography variant="caption" color="text.secondary">Surface container 1</Typography><Typography variant="body2">Grouped panel</Typography></Paper>
            <Paper sx={{ p: 1.5, bgcolor: 'var(--surface-2)' }}><Typography variant="caption" color="text.secondary">Surface container 2</Typography><Typography variant="body2">Nested, selected</Typography></Paper>
            <Paper sx={{ p: 1.5, bgcolor: 'var(--primary-container)', color: 'var(--on-primary-container)' }}><Typography variant="caption">Primary container</Typography><Typography variant="body2" sx={{ fontWeight: 600 }}>Active destination</Typography></Paper>
            <Paper sx={{ p: 1.5, bgcolor: 'var(--secondary-container)', color: 'var(--on-secondary-container)' }}><Typography variant="caption">Secondary container</Typography><Typography variant="body2" sx={{ fontWeight: 600 }}>Effort / training</Typography></Paper>
          </Box>
          <Box sx={{ mt: 2, maxWidth: 420 }}>
            <BottomNavigation showLabels value={0} sx={{ borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
              {LIB.slice(0, 4).map((it) => <BottomNavigationAction key={it.key} label={it.label} icon={<Ic d={it.icon} />} />)}
            </BottomNavigation>
            <Typography variant="caption" color="text.secondary">Phone bottom navigation</Typography>
          </Box>
        </CardContent></Card>
      </Stack>
    </Shell>
  );
}

function Swatch({ name, hex, on, note }) {
  const fg = on || (lum(hex) > 0.35 ? '#111' : '#fff');
  return (
    <Box sx={{ borderRadius: 2, p: 1.25, bgcolor: hex, color: fg, minHeight: 72, display: 'flex', flexDirection: 'column', border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{name}</Typography>
      <Typography variant="caption" sx={{ mt: 'auto', fontFamily: 'ui-monospace, monospace', opacity: 0.85 }}>{hex.toUpperCase()}</Typography>
      {note && <Typography variant="caption" sx={{ opacity: 0.85 }}>{note}</Typography>}
    </Box>
  );
}

function TokensScreen({ opt, mode }) {
  const t = opt[mode];
  const checks = [
    ['Primary text on paper', t.primary.main, t.paper, 4.5], ['On-primary on primary', t.primary.contrastText, t.primary.main, 4.5],
    ['Body text on background', t.text, t.bg, 7], ['Secondary text on background', t.text2, t.bg, 4.5], ['Secondary text on container 1', t.text2, t.c1, 4.5],
    ['Secondary colour on paper', t.secondary.main, t.paper, 4.5], ['On-container on primary container', t.primary.onContainer, t.primary.container, 4.5],
    ['Error on paper', t.error.main, t.paper, 4.5], ['Warning on paper', t.warning.main, t.paper, 4.5], ['Success on paper', t.success.main, t.paper, 4.5], ['Outline on paper (3:1 for UI)', t.outline, t.paper, 3],
  ];
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" sx={{ mb: 0.5 }}>{opt.name} · {mode} tokens</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>Material colour roles for this scheme. Chart series are validated for colour-vision deficiency in this mode.</Typography>
      <Typography variant="overline" color="text.secondary">Accent roles</Typography>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', mb: 2 }}>
        <Swatch name="Primary" hex={t.primary.main} on={t.primary.contrastText} /><Swatch name="Primary container" hex={t.primary.container} on={t.primary.onContainer} />
        <Swatch name="Secondary" hex={t.secondary.main} on={t.secondary.contrastText} /><Swatch name="Secondary container" hex={t.secondary.container} on={t.secondary.onContainer} />
        <Swatch name="Tertiary (AI)" hex={t.tertiary.main} on={t.tertiary.contrastText} />
      </Box>
      <Typography variant="overline" color="text.secondary">Surfaces and text</Typography>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', mb: 2 }}>
        <Swatch name="Background" hex={t.bg} on={t.text} /><Swatch name="Paper" hex={t.paper} on={t.text} /><Swatch name="Container 1" hex={t.c1} on={t.text} /><Swatch name="Container 2" hex={t.c2} on={t.text} />
        <Swatch name="Divider" hex={t.divider} on={t.text} /><Swatch name="Outline" hex={t.outline} /><Swatch name="Text" hex={t.text} on={t.bg} /><Swatch name="Text secondary" hex={t.text2} on={t.bg} />
      </Box>
      <Typography variant="overline" color="text.secondary">Status (always with icon and word)</Typography>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', mb: 2 }}>
        <Swatch name="Success" hex={t.success.main} /><Swatch name="Warning" hex={t.warning.main} /><Swatch name="Error" hex={t.error.main} /><Swatch name="Info" hex={t.info.main} />
      </Box>
      <Typography variant="overline" color="text.secondary">Chart series, in order of assignment</Typography>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', mb: 2 }}>
        {t.chart.map((h, i) => <Swatch key={h} name={`Series ${i + 1}`} hex={h} />)}
      </Box>
      <Typography variant="overline" color="text.secondary">WCAG contrast</Typography>
      <Table size="small" sx={{ maxWidth: 640 }}>
        <TableHead><TableRow><TableCell>Pair</TableCell><TableCell align="right">Ratio</TableCell><TableCell align="right">Needs</TableCell><TableCell align="right">Result</TableCell></TableRow></TableHead>
        <TableBody>{checks.map(([n, a, b, need]) => { const r = contrast(a, b); const ok = r >= need; return (
          <TableRow key={n}><TableCell><Stack direction="row" spacing={1} alignItems="center"><Box sx={{ width: 22, height: 22, borderRadius: 1, bgcolor: b, color: a, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, border: '1px solid', borderColor: 'divider' }}>Aa</Box><span>{n}</span></Stack></TableCell><TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRatio(r)}</TableCell><TableCell align="right">{need}:1</TableCell><TableCell align="right"><Chip size="small" label={ok ? 'Pass' : 'Fail'} color={ok ? 'success' : 'error'} variant="outlined" /></TableCell></TableRow>
        ); })}</TableBody>
      </Table>
    </Box>
  );
}

/* ----------------------------------------------------------------- frame */
function Frame({ opt, mode, screen }) {
  const theme = useMemo(() => buildTheme(opt, mode), [opt, mode]);
  const ref = useRef(null); const fw = useWidth(ref);
  const compact = fw > 0 && fw < 560;
  const t = opt[mode];
  const vars = { '--primary-container': t.primary.container, '--on-primary-container': t.primary.onContainer, '--secondary-container': t.secondary.container, '--on-secondary-container': t.secondary.onContainer, '--surface-1': t.c1, '--surface-2': t.c2, '--on-primary': t.primary.contrastText };
  const Screen = { today: TodayScreen, health: HealthScreen, telemetry: TelemetryScreen, components: ComponentsScreen, tokens: TokensScreen }[screen];
  return (
    <ThemeProvider theme={theme}>
      <Compact.Provider value={compact}>
        <ScopedCssBaseline ref={ref} style={vars} sx={{ borderRadius: 3, overflow: 'hidden', border: '1px solid', borderColor: 'divider', colorScheme: mode, height: '100%' }}>
          <Screen opt={opt} mode={mode} />
        </ScopedCssBaseline>
      </Compact.Provider>
    </ThemeProvider>
  );
}

/* ----------------------------------------------------------------- studio */
const SCREENS = [['today', 'Today'], ['health', 'Health'], ['telemetry', 'Telemetry dashboard'], ['components', 'Components'], ['tokens', 'Tokens']];
function load(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch {} }

function Studio() {
  const [optId, setOpt] = useState(() => load('evo.opt', 'tidal'));
  const [mode, setMode] = useState(() => load('evo.mode', 'both'));
  const [screen, setScreen] = useState(() => load('evo.screen', 'today'));
  useEffect(() => { save('evo.opt', optId); save('evo.mode', mode); save('evo.screen', screen); }, [optId, mode, screen]);
  const opt = OPTIONS.find((o) => o.id === optId) || OPTIONS[0];
  const modes = mode === 'both' ? ['light', 'dark'] : [mode];
  return (
    <div className="studio">
      <header className="s-head">
        <div>
          <h1>EvoPath Color Studio</h1>
          <p>Four candidate colour schemes for EvoPath, rendered with Material UI components in light and dark. Example data throughout.</p>
        </div>
      </header>
      <section className="s-controls" aria-label="Scheme">
        <div className="s-options" role="radiogroup" aria-label="Colour scheme">
          {OPTIONS.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={o.id === optId} className={'s-opt' + (o.id === optId ? ' on' : '')} onClick={() => setOpt(o.id)}>
              <span className="s-dots">{[o.light.primary.main, o.light.secondary.main, o.light.tertiary.main, o.dark.bg].map((h) => <i key={h} style={{ background: h }} />)}</span>
              <span className="s-name">{o.name}</span>
              <span className={'s-tag' + (o.tag === 'Recommended' ? ' rec' : '')}>{o.tag}</span>
            </button>
          ))}
        </div>
        <p className="s-brief">{opt.brief}</p>
        <div className="s-row">
          <div className="s-seg" role="group" aria-label="Theme mode">
            {[['light', 'Light'], ['dark', 'Dark'], ['both', 'Side by side']].map(([v, l]) => <button key={v} type="button" aria-pressed={mode === v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}>{l}</button>)}
          </div>
          <div className="s-tabs" role="tablist" aria-label="Screen">
            {SCREENS.map(([v, l]) => <button key={v} type="button" role="tab" aria-selected={screen === v} className={screen === v ? 'on' : ''} onClick={() => setScreen(v)}>{l}</button>)}
          </div>
        </div>
      </section>
      <section className={'s-frames' + (modes.length > 1 ? ' two' : '')}>
        {modes.map((m) => (
          <div className="s-frame" key={m}>
            <div className="s-frame-label">{opt.name} · {m === 'light' ? 'Light' : 'Dark'}</div>
            <Frame opt={opt} mode={m} screen={screen} />
          </div>
        ))}
      </section>
      <footer className="s-foot">
        <p>Chart series in every scheme pass the colour-vision-deficiency validator in both modes (adjacent pairs, Machado 2009 simulation; the yellow slot in Indigo Clinic light relies on labels, as the validator notes). Severity, change and status are never colour alone: each carries an icon or a word.</p>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Studio />);
