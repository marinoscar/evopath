/**
 * Console → Android app → Notifications (#312).
 *
 * How many Web Push subscriptions come from the Android app (the counts
 * `GET /api/admin/android-app` returns as `pushSubscriptions`), and a "Send
 * test notification" that pushes to the CALLER's `android_app` subscriptions
 * with `POST /api/admin/android-app/test-notification`. There is no user
 * search component in the web app, so the optional `userId` is not offered;
 * the API defaults it to the caller.
 *
 * The button is disabled without `system_settings:write` (`canWrite`); the API
 * enforces the permission either way and decides everything about the send.
 * This section only shows what came back: one row per subscription, and the
 * next step for the two `reason`s the API can answer instead of sending.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { ChipProps } from '@mui/material';
import { ApiError } from '../../../services/api';
import {
  sendAndroidTestNotification,
  type AndroidAppConfig,
  type AndroidTestNotificationReason,
  type AndroidTestNotificationResponse,
  type AndroidTestNotificationResult,
} from '../../../services/healthSync';
import { useIsMounted } from '../../../hooks/useIsMounted';

/** The Web Push settings card's route, from `config/adminSections.tsx`. */
export const PUSH_SETTINGS_PATH = '/admin/settings/push';
export const TEST_NOTIFICATION_READ_ONLY =
  'Sending a test notification needs permission to change system settings.';
export const NO_ANDROID_SUBSCRIPTION_GUIDANCE =
  'On your phone: open the app → Settings → Notifications → turn on notifications, and allow notifications for the app when Android asks.';
export const PUSH_NOT_CONFIGURED_GUIDANCE =
  'Web Push is not configured on this deployment, so there is nothing to send with.';

const STATUS_CHIP: Record<AndroidTestNotificationResult['status'], { label: string; color: ChipProps['color'] }> = {
  sent: { label: 'Sent', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  gone: { label: 'Gone', color: 'warning' },
};

const REASON_CODES: readonly AndroidTestNotificationReason[] = ['NO_ANDROID_SUBSCRIPTION', 'PUSH_NOT_CONFIGURED'];

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

interface AndroidNotificationsSectionProps {
  canWrite: boolean;
  config: AndroidAppConfig | null;
}

function ReasonGuidance({ reason }: { reason: AndroidTestNotificationReason }) {
  if (reason === 'PUSH_NOT_CONFIGURED') {
    return (
      <Alert severity="warning" data-testid="android-test-reason">
        {PUSH_NOT_CONFIGURED_GUIDANCE}{' '}
        <Link component={RouterLink} to={PUSH_SETTINGS_PATH}>
          Open Web Push settings
        </Link>
      </Alert>
    );
  }
  return (
    <Alert severity="info" data-testid="android-test-reason">
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        You have no Android app subscription yet.
      </Typography>
      <Typography variant="body2">{NO_ANDROID_SUBSCRIPTION_GUIDANCE}</Typography>
    </Alert>
  );
}

export function AndroidNotificationsSection({ canWrite, config }: AndroidNotificationsSectionProps) {
  const isMounted = useIsMounted();
  const [isSending, setIsSending] = useState(false);
  const [outcome, setOutcome] = useState<AndroidTestNotificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFromError, setReasonFromError] = useState<AndroidTestNotificationReason | null>(null);

  const counts = config?.pushSubscriptions;

  const onSend = async () => {
    setIsSending(true);
    setError(null);
    setOutcome(null);
    setReasonFromError(null);
    try {
      const result = await sendAndroidTestNotification();
      if (isMounted()) setOutcome(result);
    } catch (err) {
      if (!isMounted()) return;
      // An API that answers a reason as an error code gets the same guidance.
      if (err instanceof ApiError && REASON_CODES.includes(err.code as AndroidTestNotificationReason)) {
        setReasonFromError(err.code as AndroidTestNotificationReason);
      } else if (err instanceof ApiError && err.status === 403) {
        setError('You do not have permission to send a test notification.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many test notifications. Wait a minute and try again.');
      } else {
        setError(err instanceof ApiError && err.message ? err.message : 'Failed to send the test notification.');
      }
    } finally {
      if (isMounted()) setIsSending(false);
    }
  };

  const reason = outcome?.reason ?? reasonFromError;
  const results = outcome?.results ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby="android-notifications-title">
      <Typography variant="h6" component="h2" id="android-notifications-title" gutterBottom>
        Notifications
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Phones running the Android app receive notifications as Web Push, through their own subscription.
      </Typography>

      {counts ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }} data-testid="android-push-counts">
          <Chip
            variant="outlined"
            label={`${plural(counts.androidApp, 'Android app subscription', 'Android app subscriptions')}`}
          />
          <Chip variant="outlined" label={plural(counts.androidAppUsers, 'user', 'users')} />
          <Chip variant="outlined" label={plural(counts.browser, 'browser subscription', 'browser subscriptions')} />
        </Stack>
      ) : null}

      <Tooltip title={canWrite ? '' : TEST_NOTIFICATION_READ_ONLY}>
        <span>
          <Button
            variant="outlined"
            onClick={() => void onSend()}
            disabled={!canWrite || isSending}
            startIcon={isSending ? <CircularProgress size={16} /> : undefined}
          >
            Send test notification
          </Button>
        </span>
      </Tooltip>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
        Sent to your own Android app subscriptions.
      </Typography>

      <Box aria-live="polite" sx={{ mt: 2 }}>
        <Stack spacing={1.5}>
          {error && <Alert severity="error">{error}</Alert>}
          {reason && <ReasonGuidance reason={reason} />}
          {outcome && !reason && results.length === 0 && (
            <Alert severity="info">No Android app subscription was found to send to.</Alert>
          )}
          {results.length > 0 && (
            <List dense disablePadding aria-label="Test notification results">
              {results.map((result) => {
                const chip = STATUS_CHIP[result.status];
                return (
                  <ListItem key={result.subscriptionId} divider disableGutters>
                    <ListItemText
                      primary={
                        <Stack component="span" direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                          <Chip size="small" label={chip.label} color={chip.color} />
                          <Box component="span" sx={{ fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
                            {result.endpointHost}
                          </Box>
                        </Stack>
                      }
                      secondary={
                        result.error ??
                        (result.status === 'gone' ? 'The phone no longer accepts this subscription; it was removed.' : undefined)
                      }
                    />
                  </ListItem>
                );
              })}
            </List>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}
