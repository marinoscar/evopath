/**
 * Settings → Danger Zone → Delete all my data (`/settings/danger-zone`),
 * issue #202.
 *
 * A per-user FACTORY RESET. The page's whole job is to make sure the user
 * understands what is about to happen before anything does:
 *
 *   1. an error-bordered panel saying this is irreversible, with no backup;
 *   2. what will be deleted, with live counts from `GET /api/user-data/summary`
 *      (the static list still renders if the summary fails — the warning must
 *      never depend on a request succeeding);
 *   3. what stays (the account, its role, the security audit log);
 *   4. a destructive button that opens a DIALOG (never inline) requiring both
 *      an acknowledgement checkbox and the exact phrase `DELETE MY DATA`.
 *
 * The API re-checks the phrase and decides what is deleted; this page only
 * collects the confirmation and reports the job. Like `UserTokensPage`, it
 * does not use `UserSettingsSection`: it never reads the user settings
 * document, so mounting that wrapper would fire a request nothing reads.
 *
 * No `RequirePermission`: the API enforces `user_settings:write`, which every
 * role holds — see the card's note in `config/userSettingsSections.tsx`.
 */

import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Skeleton,
  TextField,
  Typography,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useUserDataReset, useUserDataSummary } from '../hooks/useUserDataReset';
import { RESET_CONFIRMATION_PHRASE } from '../services/userData';
import type { UserDataResetResult, UserDataSummary } from '../services/userData';
import { useAuth } from '../contexts/AuthContext';
import { NotificationContext } from '../contexts/NotificationContext';
import { clearExerciseHistoryCache } from '../hooks/useExerciseHistory';
import { clearWizardDraft } from '../components/training/planWizard';

/**
 * Every category a reset deletes, in display order. `key` is the summary /
 * result field; the list renders even when the count is unknown.
 */
const DELETED_CATEGORIES: Array<{
  key: keyof UserDataSummary & string;
  singular: string;
  plural: string;
  detail: string;
}> = [
  { key: 'workouts', singular: 'workout', plural: 'workouts', detail: 'Every logged workout, set and personal record.' },
  { key: 'programs', singular: 'program', plural: 'programs', detail: 'Training programs and plans.' },
  { key: 'trainingRuns', singular: 'AI training run', plural: 'AI training runs', detail: 'Plan-generation and adaptation runs.' },
  { key: 'customExercises', singular: 'custom exercise', plural: 'custom exercises', detail: 'Exercises you added to the library.' },
  { key: 'gyms', singular: 'gym', plural: 'gyms', detail: 'Your gyms and their equipment.' },
  { key: 'measurements', singular: 'measurement', plural: 'measurements', detail: 'Health profile, measurements and check-ins.' },
  { key: 'photos', singular: 'photo', plural: 'photos', detail: 'Uploaded photos, including your profile image.' },
  { key: 'aiKeys', singular: 'AI provider key', plural: 'AI provider keys', detail: 'Your own keys for AI providers.' },
  { key: 'accessTokens', singular: 'access token', plural: 'access tokens', detail: 'Personal access tokens for the API and CLI.' },
  { key: 'notifications', singular: 'notification', plural: 'notifications', detail: 'Your notification history.' },
  { key: 'progressPhotos', singular: 'progress photo', plural: 'progress photos', detail: 'Progress photos you saved for your coach.' },
  { key: 'coachMessages', singular: 'coach message', plural: 'coach messages', detail: 'Your AI Coach conversation, nudges and weekly reviews.' },
  { key: 'memories', singular: 'memory', plural: 'memories', detail: 'Facts your AI Coach remembered about you.' },
  { key: 'activityGoals', singular: 'activity goal', plural: 'activity goals', detail: 'Your goals, archived ones included.' },
  { key: 'activityEntries', singular: 'activity entry', plural: 'activity entries', detail: 'Check-ins and the activity counted toward your goals.' },
  { key: 'healthSyncDevices', singular: 'connected phone', plural: 'connected phones', detail: 'Phones paired to sync Health Connect activity; their tokens are revoked.' },
  { key: 'healthSyncRuns', singular: 'phone sync run', plural: 'phone sync runs', detail: 'The sync history of your connected phones.' },
  { key: 'healthSyncDiagnosticReports', singular: 'phone diagnostic report', plural: 'phone diagnostic reports', detail: 'Diagnostic reports your phones uploaded.' },
  { key: 'sleepSessions', singular: 'sleep session', plural: 'sleep sessions', detail: 'Nights of sleep, including those synced from Health Connect.' },
];

const STORAGE_RESULT_KEYS = new Set(['storageObjectsDeleted', 'storageObjectsFailed']);

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The non-zero counts a finished reset reports, labelled for people. */
function resultLines(result: UserDataResetResult | null | undefined): string[] {
  if (!result) return [];
  const lines: string[] = [];
  const known = new Set<string>();
  for (const category of DELETED_CATEGORIES) {
    known.add(category.key);
    const value = result[category.key];
    if (typeof value === 'number' && value > 0) {
      lines.push(countLabel(value, category.singular, category.plural));
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (known.has(key) || STORAGE_RESULT_KEYS.has(key)) continue;
    if (typeof value === 'number' && value > 0) {
      lines.push(`${value.toLocaleString()} ${humanizeKey(key)}`);
    }
  }
  const stored = result.storageObjectsDeleted;
  if (typeof stored === 'number' && stored > 0) {
    lines.push(countLabel(stored, 'stored file', 'stored files'));
  }
  return lines;
}

export default function UserDangerZonePage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  // Optional: the provider is mounted in the shell, not necessarily in tests.
  const notifications = useContext(NotificationContext);
  const { summary, isLoading: summaryLoading, error: summaryError, refresh: refreshSummary } =
    useUserDataSummary();
  const { phase, job, error: resetError, start, reset } = useUserDataReset();

  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState('');

  const titleId = useId();
  const descriptionId = useId();
  const phraseHelpId = useId();

  const busy = phase === 'starting' || phase === 'running';
  const canConfirm = acknowledged && phrase === RESET_CONFIRMATION_PHRASE && !busy;

  const closeDialog = () => {
    if (busy) return;
    setOpen(false);
    setAcknowledged(false);
    setPhrase('');
    reset();
  };

  const clearClientCaches = () => {
    // No query cache in this app: pages fetch on mount. Drop the few
    // module-level and session caches that would otherwise outlive the data,
    // and refresh the shell's own state (profile image, notification bell).
    clearExerciseHistoryCache();
    clearWizardDraft();
    void refreshUser().catch(() => undefined);
    void notifications?.refresh().catch(() => undefined);
    void refreshSummary();
  };

  const confirm = async () => {
    if (!canConfirm) return;
    await start(phrase);
  };

  // Clear caches once per job, when it is seen to succeed.
  const clearedFor = useRef<string | null>(null);
  const succeededJobId = phase === 'succeeded' ? (job?.jobId ?? null) : null;
  useEffect(() => {
    if (!succeededJobId || clearedFor.current === succeededJobId) return;
    clearedFor.current = succeededJobId;
    clearClientCaches();
    // `clearClientCaches` reads only stable callbacks; keyed on the job alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [succeededJobId]);

  const storageFailed = job?.result?.storageObjectsFailed ?? 0;
  const removed = resultLines(job?.result);

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Delete all my data
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Factory reset: permanently delete your workouts, programs, health data, photos and keys.
        </Typography>

        <Paper
          component="section"
          aria-labelledby="danger-zone-heading"
          variant="outlined"
          sx={{ borderColor: 'error.main', borderWidth: 2, p: { xs: 2, sm: 3 } }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <WarningAmberIcon color="error" aria-hidden />
            <Typography id="danger-zone-heading" variant="h5" component="h2" color="error">
              Danger Zone
            </Typography>
          </Box>
          <Typography sx={{ mb: 2 }}>
            This is a factory reset of <strong>your</strong> account. Everything you have
            recorded is deleted permanently. <strong>It cannot be undone:</strong> there is no
            backup and no way to recover it afterwards.
          </Typography>

          <Typography variant="h6" component="h3" id="will-delete-heading">
            What will be deleted
          </Typography>
          {summaryError && (
            <Alert severity="warning" sx={{ my: 1 }}>
              Could not load how much data you have. Everything below will still be deleted.
            </Alert>
          )}
          <List dense aria-labelledby="will-delete-heading" sx={{ mb: 2 }}>
            {DELETED_CATEGORIES.map((category) => {
              const count = summary?.[category.key];
              let primary: ReactNode;
              if (summaryLoading) {
                primary = (
                  <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Skeleton
                      variant="text"
                      width={40}
                      aria-hidden
                      data-testid="summary-count-skeleton"
                    />
                    <span>{category.plural}</span>
                  </Box>
                );
              } else if (typeof count === 'number') {
                primary = countLabel(count, category.singular, category.plural);
              } else {
                primary = category.plural.charAt(0).toUpperCase() + category.plural.slice(1);
              }
              return (
                <ListItem key={category.key} disableGutters>
                  <ListItemText primary={primary} secondary={category.detail} />
                </ListItem>
              );
            })}
          </List>
          {summaryLoading && (
            <Typography variant="body2" color="text.secondary" role="status" sx={{ mb: 2 }}>
              Counting your data…
            </Typography>
          )}

          <Typography variant="h6" component="h3" id="stays-heading">
            What stays
          </Typography>
          <List dense aria-labelledby="stays-heading" sx={{ mb: 2 }}>
            <ListItem disableGutters>
              <ListItemText
                primary="Your sign-in and account, and your role"
                secondary="You stay signed in and can start fresh straight away."
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText
                primary="The security audit log"
                secondary="Kept for security; it records that this reset happened."
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText primary="Other users" secondary="Nobody else's data is affected." />
            </ListItem>
          </List>

          <Button
            variant="contained"
            color="error"
            startIcon={<DeleteForeverIcon />}
            onClick={() => setOpen(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Delete all my data…
          </Button>
        </Paper>

        <Dialog
          open={open}
          onClose={closeDialog}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle id={titleId}>
            {phase === 'succeeded' ? 'Your data has been deleted' : 'Delete all your data?'}
          </DialogTitle>

          {phase === 'succeeded' ? (
            <>
              <DialogContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <CheckCircleIcon color="success" aria-hidden />
                  <DialogContentText id={descriptionId}>
                    The reset finished. Your account is still here, empty and ready to start
                    fresh.
                  </DialogContentText>
                </Box>
                {removed.length > 0 && (
                  <>
                    <Typography variant="subtitle2" component="h3" id="removed-heading">
                      Removed
                    </Typography>
                    <List dense aria-labelledby="removed-heading">
                      {removed.map((line) => (
                        <ListItem key={line} disableGutters>
                          <ListItemText primary={line} />
                        </ListItem>
                      ))}
                    </List>
                  </>
                )}
                {storageFailed > 0 && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    {countLabel(storageFailed, 'stored file', 'stored files')} could not be
                    removed from storage. Your records are gone; an administrator can clean up
                    the leftover files.
                  </Alert>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={closeDialog}>Close</Button>
                <Button
                  variant="contained"
                  autoFocus
                  onClick={() => {
                    closeDialog();
                    navigate('/', { replace: true });
                  }}
                >
                  Go to home
                </Button>
              </DialogActions>
            </>
          ) : busy ? (
            <DialogContent>
              <DialogContentText id={descriptionId} role="status" sx={{ mb: 2 }}>
                Deleting your data… Keep this page open; this usually takes a few seconds.
              </DialogContentText>
              <LinearProgress aria-label="Deleting your data" color="error" />
            </DialogContent>
          ) : (
            <>
              <DialogContent>
                <DialogContentText id={descriptionId} sx={{ mb: 2 }}>
                  This permanently deletes all of your workouts, programs, health data, gyms,
                  photos, keys and tokens. There is no backup and no undo. Your account stays so
                  you can start fresh.
                </DialogContentText>

                {phase === 'failed' && resetError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    <AlertTitle>The reset did not finish</AlertTitle>
                    {resetError}
                  </Alert>
                )}

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={acknowledged}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setAcknowledged(e.target.checked)
                      }
                      color="error"
                    />
                  }
                  label="I understand this permanently deletes all my data and cannot be undone"
                  sx={{ mb: 2, alignItems: 'flex-start', '& .MuiCheckbox-root': { pt: 0.5 } }}
                />

                <Typography id={phraseHelpId} variant="body2" sx={{ mb: 1 }}>
                  To confirm, type{' '}
                  <Box
                    component="code"
                    sx={{
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      px: 0.5,
                      bgcolor: 'action.hover',
                      borderRadius: 0.5,
                    }}
                  >
                    {RESET_CONFIRMATION_PHRASE}
                  </Box>{' '}
                  exactly as shown (capital letters).
                </Typography>
                <TextField
                  label="Confirmation phrase"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  fullWidth
                  autoComplete="off"
                  slotProps={{
                    htmlInput: {
                      'aria-describedby': phraseHelpId,
                      spellCheck: false,
                      autoCapitalize: 'characters',
                    },
                  }}
                />
              </DialogContent>
              <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
                <Button onClick={closeDialog} autoFocus>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  color="error"
                  disabled={!canConfirm}
                  onClick={() => void confirm()}
                >
                  {phase === 'failed' ? 'Try again' : 'Delete all my data'}
                </Button>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Box>
    </Container>
  );
}
