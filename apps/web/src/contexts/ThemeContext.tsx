import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useMediaQuery } from '@mui/material';
import { ThemeProvider, useColorScheme, useTheme, type Theme } from '@mui/material/styles';
import { theme, ThemeMode } from '../theme';

interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The localStorage key MUI's colour-scheme provider persists the mode under.
 * Pre-dates the MUI integration, so it stays `theme_mode` (not MUI's default
 * `mui-mode`): `visual/main.tsx` seeds it, and a user's saved choice must
 * survive the switch.
 */
const THEME_STORAGE_KEY = 'theme_mode';

const VALID_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/**
 * MUI's provider takes whatever string is in storage as the mode. Anything
 * that is not `light | dark | system` is removed BEFORE the provider mounts
 * so it falls back to `defaultMode` (`system`) — the behaviour the old
 * hand-rolled context had, and what its tests assert.
 */
function sanitiseStoredMode(): void {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved !== null && !VALID_MODES.includes(saved as ThemeMode)) {
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode, blocked): the provider will simply
    // start from `defaultMode`.
  }
}

/**
 * Keeps `<meta name="theme-color">` on the resolved scheme's `background.paper`
 * so the browser / installed-PWA chrome matches the app bar (which the theme
 * paints in `background.paper`). `index.html` ships the brand colour as the
 * pre-hydration value; this takes over once React is up.
 */
function syncThemeColorMeta(color: string): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  if (meta.content !== color) meta.content = color;
}

interface ThemeContextProviderProps {
  children: ReactNode;
}

/**
 * Mounts THE application theme (`theme/index.ts`) and exposes the mode
 * controls the rest of the app uses (`useThemeContext`).
 *
 * The MUI `ThemeProvider` is the one source of truth for the mode: it reads
 * and writes `theme_mode`, listens to `prefers-color-scheme`, toggles the
 * `.light` / `.dark` class the CSS variables key on, and re-derives
 * `theme.palette` per scheme (`forceThemeRerender`) so code that reads the
 * palette object directly — charts, `palette.mode` checks — sees the active
 * scheme's values. `noSsr` makes the first render read storage synchronously
 * (this is a client-only SPA; there is no hydration pass to protect).
 */
export function ThemeContextProvider({ children }: ThemeContextProviderProps) {
  // A lazy initializer runs exactly once per mount and BEFORE the children
  // (the provider) render, which is when MUI reads the stored value.
  useState(() => {
    sanitiseStoredMode();
    return null;
  });

  return (
    <ThemeProvider
      theme={theme}
      modeStorageKey={THEME_STORAGE_KEY}
      defaultMode="system"
      disableTransitionOnChange
      forceThemeRerender
      noSsr
    >
      <ThemeContextBridge>{children}</ThemeContextBridge>
    </ThemeProvider>
  );
}

/** Derives the public context value from MUI's colour-scheme state. */
function ThemeContextBridge({ children }: ThemeContextProviderProps) {
  const { mode: schemeMode, setMode: setSchemeMode, systemMode } = useColorScheme();
  const muiTheme = useTheme();

  // `systemMode` is `undefined` whenever the mode is not `system` (and on a
  // hydration-style first render); the media query is the fallback for the
  // one case that matters, `system` with no answer yet.
  const prefersDarkMode = useMediaQuery('(prefers-color-scheme: dark)');

  const mode: ThemeMode =
    schemeMode === 'light' || schemeMode === 'dark' || schemeMode === 'system' ? schemeMode : 'system';

  const isDarkMode = useMemo(() => {
    if (mode === 'system') {
      return systemMode ? systemMode === 'dark' : prefersDarkMode;
    }
    return mode === 'dark';
  }, [mode, systemMode, prefersDarkMode]);

  const setMode = useCallback(
    (newMode: ThemeMode) => {
      setSchemeMode(newMode);
    },
    [setSchemeMode],
  );

  const toggleMode = useCallback(() => {
    setMode(isDarkMode ? 'light' : 'dark');
  }, [isDarkMode, setMode]);

  useEffect(() => {
    const scheme = isDarkMode ? 'dark' : 'light';
    const paper =
      muiTheme.colorSchemes?.[scheme]?.palette.background.paper ?? muiTheme.palette.background.paper;
    syncThemeColorMeta(paper);
  }, [isDarkMode, muiTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, theme: muiTheme, setMode, toggleMode, isDarkMode }),
    [mode, muiTheme, setMode, toggleMode, isDarkMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeContextProvider');
  }
  return context;
}
