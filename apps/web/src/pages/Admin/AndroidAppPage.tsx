/**
 * Console → Android app (`/admin/settings/android`), issue #283, epic #276.
 *
 * Which Android app builds this deployment trusts: each trusted
 * (package, signing SHA-256) pair becomes a Digital Asset Links statement at
 * `/.well-known/assetlinks.json`, which is what lets the app's Trusted Web
 * Activity open full screen. The page lists the trusted pairs, adds one by
 * hand, offers a one-click Trust for each pair a paired phone has reported,
 * and previews the JSON the deployment serves.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('system_settings:read')`, the string
 * `GET /api/admin/android-app` enforces and the card in
 * `config/adminSections.tsx` declares. Every write control is disabled here
 * without `system_settings:write`; the API enforces it either way. Each change
 * is saved at once with `PUT /api/admin/android-app`.
 *
 * Issue #287 adds the Releases section (`AndroidReleasesSection`): the APKs
 * this server hosts, under the same route and the same write gate.
 *
 * Issue #312 adds the Notifications section (`AndroidNotificationsSection`):
 * Android app push subscription counts and a test send, same write gate.
 */
import { useCallback, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { usePermissions } from '../../hooks/usePermissions';
import { useAndroidAppConfig } from '../../hooks/useHealthSync';
import {
  ANDROID_PACKAGE_PATTERN,
  MAX_TRUSTED_APPS,
  SHA256_FINGERPRINT_PATTERN,
  type TrustedApp,
} from '../../services/healthSync';
import { formatRelativeTime } from '../../utils/relativeTime';
import { AndroidReleasesSection } from '../../components/admin/androidApp/AndroidReleasesSection';
import { AndroidNotificationsSection } from '../../components/admin/androidApp/AndroidNotificationsSection';

/** Mirrors the `Android app` card in `config/adminSections.tsx`, word for word. */
export const ANDROID_APP_TITLE = 'Android app';
export const ANDROID_APP_DESCRIPTION =
  'Publish the Android app’s APK, trust its signing certificate so it opens full screen, and preview the Digital Asset Links file.';
export const READ_ONLY_MESSAGE =
  'You can view these settings. Changing the trusted apps or releases needs permission to change system settings.';
export const PACKAGE_ERROR = 'Enter an Android package name, such as com.example.app.';
export const SHA_ERROR = 'Enter a SHA-256 fingerprint: 32 pairs of hex digits separated by colons.';

const MONO = { fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' } as const;

function sameApp(a: TrustedApp, b: TrustedApp): boolean {
  return a.packageName === b.packageName && a.sha256.toUpperCase() === b.sha256.toUpperCase();
}

/** Accept lower case and surrounding spaces; the API wants upper-case colon hex. */
export function normalizeSha256(value: string): string {
  return value.trim().toUpperCase();
}

export default function AndroidAppPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('system_settings:write');
  const { config, isLoading, error, isSaving, saveError, save, refresh } = useAndroidAppConfig();
  const onTrustMayHaveChanged = useCallback(() => void refresh(), [refresh]);

  const [packageName, setPackageName] = useState('');
  const [sha256, setSha256] = useState('');
  const [formErrors, setFormErrors] = useState<{ packageName?: string; sha256?: string; form?: string }>({});

  const trusted = config?.trustedApps ?? [];
  const reported = config?.reportedApps ?? [];
  const full = trusted.length >= MAX_TRUSTED_APPS;
  const writeDisabled = !canWrite || isSaving;

  const isTrusted = (app: TrustedApp) => trusted.some((t) => sameApp(t, app));

  const addApp = async (app: TrustedApp) => {
    if (isTrusted(app) || full) return false;
    return save([...trusted, app]);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = { packageName: packageName.trim(), sha256: normalizeSha256(sha256) };
    const errors: typeof formErrors = {};
    if (!ANDROID_PACKAGE_PATTERN.test(candidate.packageName)) errors.packageName = PACKAGE_ERROR;
    if (!SHA256_FINGERPRINT_PATTERN.test(candidate.sha256)) errors.sha256 = SHA_ERROR;
    if (!errors.packageName && !errors.sha256 && isTrusted(candidate)) errors.form = 'That app is already trusted.';
    if (!errors.packageName && !errors.sha256 && !errors.form && full) {
      errors.form = `At most ${MAX_TRUSTED_APPS} apps can be trusted.`;
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (await addApp(candidate)) {
      setPackageName('');
      setSha256('');
    }
  };

  let content;
  if (isLoading && !config) {
    content = <Skeleton variant="rounded" height={200} />;
  } else if (error && !config) {
    content = <Alert severity="error">{error}</Alert>;
  } else {
    content = (
      <Stack spacing={3}>
        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby="trusted-apps-title">
          <Typography variant="h6" component="h2" id="trusted-apps-title" gutterBottom>
            Trusted apps
          </Typography>
          {trusted.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No app is trusted yet. Until one is, the Android app opens this site with a browser address bar.
            </Typography>
          ) : (
            <List dense disablePadding aria-label="Trusted apps">
              {trusted.map((app) => (
                <ListItem
                  key={`${app.packageName}|${app.sha256}`}
                  divider
                  disableGutters
                  secondaryAction={
                    <Tooltip title={canWrite ? 'Remove' : READ_ONLY_MESSAGE}>
                      <span>
                        <IconButton
                          edge="end"
                          aria-label={`Remove ${app.packageName}`}
                          disabled={writeDisabled}
                          onClick={() => void save(trusted.filter((t) => !sameApp(t, app)))}
                        >
                          <DeleteOutlineIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  }
                >
                  <ListItemText
                    sx={{ pr: 6 }}
                    primary={app.packageName}
                    secondary={<Box component="span" sx={MONO}>{app.sha256}</Box>}
                  />
                </ListItem>
              ))}
            </List>
          )}

          <Box component="form" onSubmit={(e) => void onSubmit(e)} noValidate sx={{ mt: 2 }} aria-label="Add a trusted app">
            <Stack spacing={1.5}>
              <TextField
                label="Package name"
                size="small"
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                error={Boolean(formErrors.packageName)}
                helperText={formErrors.packageName}
                disabled={writeDisabled}
                fullWidth
              />
              <TextField
                label="Signing certificate SHA-256"
                size="small"
                value={sha256}
                onChange={(e) => setSha256(e.target.value)}
                error={Boolean(formErrors.sha256)}
                helperText={formErrors.sha256 ?? 'From the release keystore, e.g. keytool -list -v.'}
                disabled={writeDisabled}
                fullWidth
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
              />
              {formErrors.form && <Alert severity="warning">{formErrors.form}</Alert>}
              <Box>
                <Button type="submit" variant="contained" disabled={writeDisabled || full}>
                  Add trusted app
                </Button>
              </Box>
            </Stack>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby="reported-apps-title">
          <Typography variant="h6" component="h2" id="reported-apps-title" gutterBottom>
            Reported by paired phones
          </Typography>
          {reported.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No paired phone has reported its app signature yet.
            </Typography>
          ) : (
            <List dense disablePadding aria-label="Reported apps">
              {reported.map((app) => {
                const already = isTrusted(app);
                return (
                  <ListItem key={`${app.packageName}|${app.sha256}`} divider disableGutters sx={{ display: 'block' }}>
                    <ListItemText
                      primary={app.packageName}
                      secondary={
                        <>
                          <Box component="span" sx={{ ...MONO, display: 'block' }}>
                            {app.sha256}
                          </Box>
                          {app.deviceCount === 1 ? '1 phone' : `${app.deviceCount} phones`}
                          {app.lastSeenAt ? ` · last seen ${formatRelativeTime(app.lastSeenAt)}` : ''}
                        </>
                      }
                    />
                    <Button
                      size="small"
                      variant={already ? 'text' : 'outlined'}
                      disabled={writeDisabled || already || full}
                      onClick={() => void addApp({ packageName: app.packageName, sha256: app.sha256 })}
                      aria-label={already ? `${app.packageName} is trusted` : `Trust ${app.packageName}`}
                    >
                      {already ? 'Trusted' : 'Trust'}
                    </Button>
                  </ListItem>
                );
              })}
            </List>
          )}
        </Paper>

        {/* #287: the APKs this server hosts. Upload and make-current can
            trust the signer server-side, so they re-read the config. */}
        <AndroidReleasesSection canWrite={canWrite} config={config} onTrustMayHaveChanged={onTrustMayHaveChanged} />

        {/* #312: Android app push subscriptions and a test send. */}
        <AndroidNotificationsSection canWrite={canWrite} config={config} />

        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby="assetlinks-title">
          <Typography variant="h6" component="h2" id="assetlinks-title" gutterBottom>
            Digital Asset Links
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Served at <code>/.well-known/assetlinks.json</code>.
          </Typography>
          <Box
            component="pre"
            tabIndex={0}
            aria-label="assetlinks.json preview"
            data-testid="assetlinks-preview"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 320,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              bgcolor: 'action.hover',
              borderRadius: 1,
            }}
          >
            {JSON.stringify(config?.assetLinks ?? [], null, 2)}
          </Box>
        </Paper>
      </Stack>
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {ANDROID_APP_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {ANDROID_APP_DESCRIPTION}
        </Typography>
        {!canWrite && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {READ_ONLY_MESSAGE}
          </Alert>
        )}
        {saveError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {saveError}
          </Alert>
        )}
        {content}
      </Box>
    </Container>
  );
}
