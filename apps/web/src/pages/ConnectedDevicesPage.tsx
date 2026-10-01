/**
 * Settings → Connected devices (`/settings/connected-devices`), issue #283,
 * epic #276.
 *
 * The phones paired to sync Health Connect activity: each one's last sync,
 * token expiry, last error and time zone, its sync history and uploaded
 * diagnostic reports, and Unpair. No phone yet: how to get the Android app.
 * Inside the app's own TWA, a button jumps to the native Health sync screen.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('goals:read')`, the exact string the health-sync
 * controller's reads enforce and the card in `config/userSettingsSections.tsx`
 * declares. Unpair needs `goals:write`, offered only to holders; the API
 * enforces both either way.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Container, Link, Skeleton, Snackbar, Stack, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { REPO_SLUG } from '@app/shared';
import { usePermissions } from '../hooks/usePermissions';
import { useHealthSyncDevices, useLatestRelease } from '../hooks/useHealthSync';
import {
  ANDROID_APP_SETTINGS_PATH,
  ANDROID_HEALTH_SYNC_DEEP_LINK,
  androidReleaseUrl,
  type Device,
} from '../services/healthSync';
import { isRunningInTwa } from '../utils/twa';
import { DeviceCard } from '../components/settings/connectedDevices/DeviceCard';
import { GetAndroidApp } from '../components/settings/connectedDevices/GetAndroidApp';
import { UnpairDialog } from '../components/settings/connectedDevices/UnpairDialog';

export const CONNECTED_DEVICES_TITLE = 'Connected devices';
export const CONNECTED_DEVICES_DESCRIPTION =
  'Phones that sync your steps, walks and runs from Health Connect: sync history, diagnostics and unpairing.';
export const OPEN_HEALTH_SYNC_LABEL = 'Open Health sync on this phone';

export default function ConnectedDevicesPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('goals:write');
  const [inTwa] = useState(() => isRunningInTwa());
  const { devices, isLoading, error, refresh } = useHealthSyncDevices();
  // #287: with an APK hosted on this server, "get the app" goes to the
  // Android app page instead of GitHub. A failed lookup just keeps GitHub.
  const { release } = useLatestRelease();
  const [unpairing, setUnpairing] = useState<Device | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  let body;
  if (isLoading && devices.length === 0) {
    body = (
      <Box data-testid="connected-devices-loading">
        <Skeleton variant="rounded" height={120} />
      </Box>
    );
  } else if (error && devices.length === 0) {
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
  } else if (devices.length === 0) {
    body = <GetAndroidApp release={release} />;
  } else {
    body = (
      <Stack spacing={2}>
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            canWrite={canWrite}
            onUnpair={setUnpairing}
            latestVersionName={
              release && release.versionCode === device.latestVersionCode ? release.versionName : null
            }
          />
        ))}
        <Typography variant="body2" color="text.secondary">
          Adding another phone?{' '}
          {release ? (
            <Link component={RouterLink} to={ANDROID_APP_SETTINGS_PATH}>
              Get the Android app
            </Link>
          ) : (
            <Link href={androidReleaseUrl(REPO_SLUG)} target="_blank" rel="noopener noreferrer">
              Get the Android app
            </Link>
          )}
        </Typography>
      </Stack>
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {CONNECTED_DEVICES_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {CONNECTED_DEVICES_DESCRIPTION}
        </Typography>

        {inTwa && (
          <Button
            variant="contained"
            href={ANDROID_HEALTH_SYNC_DEEP_LINK}
            endIcon={<OpenInNewIcon />}
            sx={{ mb: 2, minHeight: 44 }}
          >
            {OPEN_HEALTH_SYNC_LABEL}
          </Button>
        )}

        {body}
      </Box>

      <UnpairDialog
        device={unpairing}
        onClose={() => setUnpairing(null)}
        onUnpaired={(device, deletedEntries) => {
          setUnpairing(null);
          setNotice(
            deletedEntries
              ? `${device.name} was unpaired and its imported activity deleted.`
              : `${device.name} was unpaired.`,
          );
          void refresh();
        }}
      />

      <Snackbar open={notice !== null} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice} />
    </Container>
  );
}
