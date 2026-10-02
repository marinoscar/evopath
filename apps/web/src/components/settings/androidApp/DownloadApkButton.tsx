/**
 * "Download APK" (#287). Asks the API for a short-lived download link, then
 * NAVIGATES to it: a real navigation, not a blob, is what lets Chrome and the
 * TWA on Android download the file natively and hand it to the installer.
 * The link is minted per click because it expires after ten minutes.
 *
 * `compact` (#299) is the in-TWA update banner's variant: a small button
 * labelled with the version, and an error that offers a Retry. It renders as
 * a fragment so the banner's wrapping action row lays the button out next to
 * its siblings and drops the error onto a line of its own.
 */
import { useState } from 'react';
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { createDownloadLink, downloadNavigator, type Release } from '../../../services/healthSync';
import { healthSyncErrorMessage } from '../../../hooks/useHealthSync';
import { useIsMounted } from '../../../hooks/useIsMounted';

export const DOWNLOAD_APK_LABEL = 'Download APK';

interface DownloadApkButtonProps {
  release: Pick<Release, 'id' | 'versionName'>;
  /** Draw the button as the page's call to action (an update is waiting). */
  emphasized?: boolean;
  /** Draw it quietly (the installed build is already current). */
  quiet?: boolean;
  /** Draw it small, labelled "Download v<versionName>", with a Retry on error (the update banner). */
  compact?: boolean;
}

export function compactDownloadLabel(versionName: string): string {
  return `Download v${versionName}`;
}

export function DownloadApkButton({
  release,
  emphasized = false,
  quiet = false,
  compact = false,
}: DownloadApkButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await createDownloadLink(release.id);
      downloadNavigator.assign(link.url);
    } catch (err) {
      if (isMounted()) setError(healthSyncErrorMessage(err, 'Could not start the download. Try again.'));
    } finally {
      if (isMounted()) setBusy(false);
    }
  };

  if (compact) {
    const label = compactDownloadLabel(release.versionName);
    return (
      <>
        <Button
          variant="contained"
          size="small"
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
          disabled={busy}
          aria-busy={busy}
          onClick={() => void download()}
          sx={{ minHeight: 36 }}
        >
          {label}
        </Button>
        {error && (
          <Alert
            severity="error"
            sx={{ flexBasis: '100%', order: 1 }}
            action={
              <Button color="inherit" size="small" onClick={() => void download()} disabled={busy}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}
      </>
    );
  }

  return (
    <Box>
      <Button
        variant={quiet ? 'outlined' : 'contained'}
        color={emphasized ? 'warning' : 'primary'}
        size={emphasized ? 'large' : 'medium'}
        startIcon={busy ? <CircularProgress size={18} color="inherit" /> : <DownloadIcon />}
        disabled={busy}
        onClick={() => void download()}
        aria-label={`${DOWNLOAD_APK_LABEL} ${release.versionName}`}
        sx={{ minHeight: 44 }}
      >
        {DOWNLOAD_APK_LABEL}
      </Button>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
