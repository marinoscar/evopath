/**
 * "A newer Android app is available" — issue #287, epic #276.
 *
 * Shown ONLY inside the Android app's Trusted Web Activity, when the build
 * the TWA launch URL reported (`appVersionCode`, captured by `utils/twa.ts`)
 * is older than the release this server hosts. Its primary action downloads
 * that release straight away (#299, the same signed-link flow as the Android
 * app page's `DownloadApkButton`); a secondary "Details" link opens the page.
 *
 * It asks nothing of the API outside the TWA: the installed version is read
 * from `sessionStorage` first, and only when there is one does the hook fetch
 * the latest release. In an ordinary browser tab this renders `null` with no
 * request, which is what keeps it out of every other test and the app's pixel
 * baselines (`tests/visual/`). It also renders `null` while loading, on an
 * error, on the Android app page itself, and once dismissed.
 *
 * Dismissal is remembered per versionCode in `localStorage`, so the next
 * release raises it again. Storage may be blocked: every access is guarded,
 * and a blocked store just means the banner can come back next launch.
 */
import { useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { Alert, Box, Button, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useLatestRelease } from '../../hooks/useHealthSync';
import { ANDROID_APP_SETTINGS_PATH } from '../../services/healthSync';
import { androidStorageKey } from '../../utils/androidIdentity';
import { getInstalledAppVersion } from '../../utils/twa';
import { DownloadApkButton } from '../settings/androidApp/DownloadApkButton';

export const ANDROID_UPDATE_DISMISSED_KEY = androidStorageKey('androidUpdate.dismissedVersionCode');

function readDismissed(): number | null {
  try {
    const raw = window.localStorage.getItem(ANDROID_UPDATE_DISMISSED_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeDismissed(versionCode: number): void {
  try {
    window.localStorage.setItem(ANDROID_UPDATE_DISMISSED_KEY, String(versionCode));
  } catch {
    // Storage blocked: dismissed for this render tree only.
  }
}

export function AndroidUpdateBanner() {
  const [installed] = useState(() => getInstalledAppVersion());
  const { release } = useLatestRelease(installed !== null);
  const [dismissed, setDismissed] = useState<number | null>(() => (installed ? readDismissed() : null));
  const { pathname } = useLocation();

  if (!installed || !release) return null;
  if (installed.versionCode >= release.versionCode) return null;
  if (dismissed === release.versionCode) return null;
  if (pathname === ANDROID_APP_SETTINGS_PATH) return null;

  const dismiss = () => {
    writeDismissed(release.versionCode);
    setDismissed(release.versionCode);
  };

  return (
    <Alert
      severity="info"
      sx={{ mb: 2, '& .MuiAlert-message': { flexGrow: 1, minWidth: 0 } }}
      data-testid="android-update-banner"
      action={
        <IconButton color="inherit" size="small" aria-label="Dismiss update notice" onClick={dismiss}>
          <CloseIcon fontSize="small" />
        </IconButton>
      }
    >
      Android app {release.versionName} is available.
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 1 }}>
        <DownloadApkButton release={release} compact />
        <Button color="inherit" size="small" component={RouterLink} to={ANDROID_APP_SETTINGS_PATH} sx={{ minHeight: 36 }}>
          Details
        </Button>
      </Box>
    </Alert>
  );
}
