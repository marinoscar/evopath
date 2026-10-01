/**
 * Settings → Android app (`/settings/android-app`), issue #287, epic #276.
 *
 * The APK this server hosts: its version, release date, size and notes, a
 * Download button, how to install it, and its SHA-256 to check the file
 * against. Inside the app's own TWA it also says whether the installed build
 * is current. With nothing published yet it falls back to the GitHub release.
 *
 * Ungated on purpose, like the caller's own preferences: the latest-release
 * and download-link routes are `@Auth()` with no permission, so every
 * signed-in user may install the app. The card in
 * `config/userSettingsSections.tsx` declares no permission for that reason.
 * Whether an update exists is decided by comparing the API's versionCode with
 * the one the TWA launch URL reported; nothing here grants anything.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useLatestRelease } from '../hooks/useHealthSync';
import { formatMegabytes, type Release } from '../services/healthSync';
import { ANDROID_APP_LABEL } from '../utils/androidIdentity';
import { getInstalledAppVersion, isRunningInTwa, type InstalledAppVersion } from '../utils/twa';
import { DownloadApkButton } from '../components/settings/androidApp/DownloadApkButton';
import { GetAndroidApp } from '../components/settings/connectedDevices/GetAndroidApp';

/** Mirrors the `Android app` card in `config/userSettingsSections.tsx`, word for word. */
export const ANDROID_APP_PAGE_TITLE = 'Android app';
export const ANDROID_APP_PAGE_DESCRIPTION =
  'Download and install the Android app, check for updates and verify the file.';

export const INSTALL_STEPS = [
  `Tap Download APK. When Android asks, allow installing apps from this source (your browser, or the ${ANDROID_APP_LABEL} app).`,
  'Open the downloaded file and tap Install (or Update).',
  `Open ${ANDROID_APP_LABEL} and enter this server’s address:`,
] as const;

export const NO_RELEASE_MESSAGE =
  'No Android app has been published on this server yet. You can get the latest build from GitHub instead.';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function InstalledStatus({ installed, release }: { installed: InstalledAppVersion; release: Release }) {
  const label = installed.versionName ?? `build ${installed.versionCode}`;
  if (installed.versionCode >= release.versionCode) {
    return (
      <Alert severity="success" data-testid="installed-up-to-date">
        Installed version {label} — up to date.
      </Alert>
    );
  }
  return (
    <Alert severity="warning" data-testid="installed-update-available">
      Update available: {release.versionName}. You have {label}.
    </Alert>
  );
}

function Checksum({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
    } catch {
      // Clipboard blocked: the value stays selectable on screen.
    }
  };
  return (
    <Box>
      <Typography variant="subtitle2" component="h3">
        SHA-256 checksum
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box
          component="code"
          data-testid="release-sha256"
          sx={{ fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere', flex: 1, minWidth: 0, pt: 1 }}
        >
          {sha}
        </Box>
        <Tooltip title="Copy checksum">
          <IconButton aria-label="Copy checksum" onClick={() => void copy()}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Snackbar open={copied} autoHideDuration={2000} onClose={() => setCopied(false)} message="Checksum copied" />
    </Box>
  );
}

function ReleaseCard({ release, installed }: { release: Release; installed: InstalledAppVersion | null }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const updateAvailable = installed !== null && installed.versionCode < release.versionCode;
  const upToDate = installed !== null && !updateAvailable;

  return (
    <Stack spacing={2}>
      {installed && <InstalledStatus installed={installed} release={release} />}

      <Card variant="outlined" component="section" aria-labelledby="android-release-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-release-title">
            Version {release.versionName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Released {formatDate(release.createdAt)} · {formatMegabytes(release.sizeBytes)} · build{' '}
            {release.versionCode}
          </Typography>
          {release.notes && (
            <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
              {release.notes}
            </Typography>
          )}
          <DownloadApkButton release={release} emphasized={updateAvailable} quiet={upToDate} />
        </CardContent>
      </Card>

      <Card variant="outlined" component="section" aria-labelledby="android-install-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-install-title" gutterBottom>
            Install it
          </Typography>
          <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Install steps">
            {INSTALL_STEPS.map((step, index) => (
              <Typography component="li" variant="body2" key={step} sx={{ mb: 0.5 }}>
                {step}
                {index === INSTALL_STEPS.length - 1 && origin && (
                  <>
                    {' '}
                    <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
                      {origin}
                    </Box>
                  </>
                )}
              </Typography>
            ))}
          </Box>
          <Box sx={{ mt: 2 }}>
            <Checksum sha={release.fileSha256} />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default function AndroidAppDownloadPage() {
  const { release, isLoading, error, refresh } = useLatestRelease();
  const [installed] = useState(() => (isRunningInTwa() ? getInstalledAppVersion() : null));

  let body;
  if (isLoading && !release) {
    body = <Skeleton variant="rounded" height={200} data-testid="android-app-loading" />;
  } else if (error && !release) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  } else if (!release) {
    body = (
      <Stack spacing={2}>
        <Alert severity="info" data-testid="no-release">
          {NO_RELEASE_MESSAGE}
        </Alert>
        <GetAndroidApp />
      </Stack>
    );
  } else {
    body = <ReleaseCard release={release} installed={installed} />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {ANDROID_APP_PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {ANDROID_APP_PAGE_DESCRIPTION}
        </Typography>
        {body}
      </Box>
    </Container>
  );
}
