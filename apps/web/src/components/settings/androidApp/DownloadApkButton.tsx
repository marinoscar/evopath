/**
 * "Download APK" (#287). Asks the API for a short-lived download link, then
 * NAVIGATES to it: a real navigation, not a blob, is what lets Chrome and the
 * TWA on Android download the file natively and hand it to the installer.
 * The link is minted per click because it expires after ten minutes.
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
}

export function DownloadApkButton({ release, emphasized = false, quiet = false }: DownloadApkButtonProps) {
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
