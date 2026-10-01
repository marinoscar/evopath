/**
 * One paired phone (#283): what it is, how its last sync went, when its token
 * expires, and the two parallel views of it (sync history, diagnostics) as
 * accordions that load on first open. Unpair needs `goals:write`, checked by
 * the caller; the API enforces it either way.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import SystemUpdateIcon from '@mui/icons-material/SystemUpdate';
import {
  ANDROID_APP_SETTINGS_PATH,
  daysUntil,
  hasTimezoneMismatch,
  type Device,
} from '../../../services/healthSync';
import { formatRelativeTime } from '../../../utils/relativeTime';
import { RunStatusChip } from './RunStatusChip';
import { SyncHistory } from './SyncHistory';
import { DiagnosticsSection } from './DiagnosticsSection';
import { formatDateTime } from './format';

/** Below this many days left, the token expiry is a warning. */
export const TOKEN_WARN_DAYS = 14;

function TokenExpiry({ device }: { device: Device }) {
  const days = daysUntil(device.tokenExpiresAt);
  if (days === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        No pairing token linked.
      </Typography>
    );
  }
  if (days < 0) {
    return (
      <Alert severity="warning" data-testid="token-expired">
        The pairing token expired on {formatDateTime(device.tokenExpiresAt)}. Re-pair from the app.
      </Alert>
    );
  }
  if (days < TOKEN_WARN_DAYS) {
    return (
      <Alert severity="warning" data-testid="token-expiring">
        The pairing token expires in {days === 1 ? '1 day' : `${days} days`}. The app asks you to re-pair.
      </Alert>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      Token expires {formatDateTime(device.tokenExpiresAt)}
    </Typography>
  );
}

/**
 * "Update available (v0.2.0)" (#287). The device row only knows the current
 * release's versionCode; its name comes from the latest release when the
 * codes agree.
 */
export function updateLabel(device: Pick<Device, 'latestVersionCode'>, latestVersionName?: string | null): string {
  if (latestVersionName) return `Update available (v${latestVersionName})`;
  if (device.latestVersionCode) return `Update available (build ${device.latestVersionCode})`;
  return 'Update available';
}

interface DeviceCardProps {
  device: Device;
  canWrite: boolean;
  onUnpair: (device: Device) => void;
  /** The current release's versionName, when it is the build `device.latestVersionCode` names. */
  latestVersionName?: string | null;
}

export function DeviceCard({ device, canWrite, onUnpair, latestVersionName = null }: DeviceCardProps) {
  const [expanded, setExpanded] = useState<'history' | 'diagnostics' | false>(false);
  const toggle = (panel: 'history' | 'diagnostics') => (_: unknown, isOpen: boolean) =>
    setExpanded(isOpen ? panel : false);
  const hardware = [device.manufacturer, device.model].filter(Boolean).join(' ');
  const revoked = device.status === 'revoked';

  return (
    <Card variant="outlined" component="article" aria-labelledby={`device-${device.id}-name`}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
          <PhoneAndroidIcon color="action" sx={{ mt: 0.5 }} />
          <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
            <Typography variant="h6" component="h2" id={`device-${device.id}-name`} sx={{ overflowWrap: 'anywhere' }}>
              {device.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {[hardware, device.androidVersion && `Android ${device.androidVersion}`, device.appVersion && `App ${device.appVersion}`]
                .filter(Boolean)
                .join(' · ') || 'Unknown device'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {!revoked && device.updateAvailable && (
              <Chip
                size="small"
                color="warning"
                icon={<SystemUpdateIcon />}
                clickable
                component={RouterLink}
                to={ANDROID_APP_SETTINGS_PATH}
                data-testid="device-update-available"
                label={updateLabel(device, latestVersionName)}
              />
            )}
            <Chip
              size="small"
              color={revoked ? 'default' : 'success'}
              label={revoked ? 'Unpaired' : 'Active'}
            />
          </Box>
        </Box>

        <Stack spacing={1} sx={{ mt: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2">
              {device.lastSyncAt ? `Last sync ${formatRelativeTime(device.lastSyncAt)}` : 'Never synced'}
            </Typography>
            {device.lastSyncStatus && <RunStatusChip status={device.lastSyncStatus} />}
          </Box>
          {!revoked && <TokenExpiry device={device} />}
          {device.lastError && (
            <Alert severity="error" data-testid="device-last-error" sx={{ overflowWrap: 'anywhere' }}>
              {device.lastError}
            </Alert>
          )}
          {hasTimezoneMismatch(device) && (
            <Alert severity="warning" data-testid="timezone-mismatch">
              The phone is on {device.timezone} but your Health Profile says {device.userTimezone}. Days are
              counted in your profile's time zone, so activity near midnight may land on a different day.
            </Alert>
          )}
        </Stack>
      </CardContent>

      <Box sx={{ px: 1 }}>
        <Accordion disableGutters elevation={0} expanded={expanded === 'history'} onChange={toggle('history')}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls={`device-${device.id}-history`}>
            <Typography>Sync history</Typography>
          </AccordionSummary>
          <AccordionDetails id={`device-${device.id}-history`}>
            {expanded === 'history' && <SyncHistory deviceId={device.id} />}
          </AccordionDetails>
        </Accordion>
        <Accordion disableGutters elevation={0} expanded={expanded === 'diagnostics'} onChange={toggle('diagnostics')}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls={`device-${device.id}-diagnostics`}>
            <Typography>Diagnostics</Typography>
          </AccordionSummary>
          <AccordionDetails id={`device-${device.id}-diagnostics`}>
            {expanded === 'diagnostics' && <DiagnosticsSection deviceId={device.id} />}
          </AccordionDetails>
        </Accordion>
      </Box>

      {canWrite && !revoked && (
        <CardActions sx={{ justifyContent: 'flex-end' }}>
          <Button color="error" onClick={() => onUnpair(device)} aria-label={`Unpair ${device.name}`} sx={{ minHeight: 44 }}>
            Unpair
          </Button>
        </CardActions>
      )}
    </Card>
  );
}
