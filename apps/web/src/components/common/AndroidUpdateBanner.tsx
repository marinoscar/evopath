/**
 * "A newer Android app is available" — issue #287, epic #276.
 *
 * Shown ONLY inside the Android app's Trusted Web Activity, when the build
 * the TWA launch URL reported (`appVersionCode`, captured by `utils/twa.ts`)
 * is older than the release this server hosts. It links to the Android app
 * page, where the user downloads the update.
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
import { Alert, Button, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useLatestRelease } from '../../hooks/useHealthSync';
import { ANDROID_APP_SETTINGS_PATH } from '../../services/healthSync';
import { getInstalledAppVersion } from '../../utils/twa';

export const ANDROID_UPDATE_DISMISSED_KEY = 'evopath.androidUpdate.dismissedVersionCode';

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
      sx={{ mb: 2 }}
      data-testid="android-update-banner"
      action={
        <>
          <Button color="inherit" size="small" component={RouterLink} to={ANDROID_APP_SETTINGS_PATH}>
            Update
          </Button>
          <IconButton color="inherit" size="small" aria-label="Dismiss update notice" onClick={dismiss}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </>
      }
    >
      Android app {release.versionName} is available.
    </Alert>
  );
}
