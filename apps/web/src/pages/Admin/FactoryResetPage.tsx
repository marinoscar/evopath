/**
 * Admin → Danger Zone → Factory reset (`/admin/settings/factory-reset`),
 * issue #211.
 *
 * A REGISTRY CARD and nothing else, per CLAUDE.md's MANDATORY Settings UI
 * Pattern: one entry in `ADMIN_SECTIONS` (`config/adminSections.tsx`), one
 * route in `App.tsx` gated on `system:factory_reset` (the string the
 * factory-reset controller enforces, held by the Admin role only), and no tab
 * anywhere.
 *
 * The deployment-wide sibling of the per-user Danger Zone (#202,
 * `pages/UserDangerZonePage.tsx`), with the same shape and the same rule: the
 * page's whole job is to make sure the administrator understands what is
 * about to happen before anything does:
 *
 *   1. an error-bordered panel saying this erases the WHOLE application for
 *      EVERYONE and cannot be undone;
 *   2. a recommendation to take a database backup first, linking to the
 *      Database Backup page;
 *   3. what will be deleted, with live deployment-wide counts from
 *      `GET /api/admin/factory-reset/summary` (the static list still renders
 *      if the summary fails — the warning must never depend on a request
 *      succeeding);
 *   4. what stays (this admin, roles, settings and integrations, the catalog,
 *      worker nodes, backups, the audit log);
 *   5. a destructive button that opens a DIALOG requiring both an
 *      acknowledgement checkbox and the exact phrase `FACTORY RESET`.
 *
 * The API re-checks the phrase and decides what is deleted; this page only
 * collects the confirmation and reports the job.
 */

import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
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
  Link,
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
import { useFactoryReset, useFactoryResetSummary } from '../../hooks/useFactoryReset';
import { FACTORY_RESET_CONFIRMATION_PHRASE } from '../../services/factoryReset';
import type { FactoryResetResult, FactoryResetSummary } from '../../services/factoryReset';
import { useAuth } from '../../contexts/AuthContext';
import { NotificationContext } from '../../contexts/NotificationContext';
import { clearExerciseHistoryCache } from '../../hooks/useExerciseHistory';
import { clearWizardDraft } from '../../components/training/planWizard';
import { ADMIN_HUB_PATH } from '../../config/adminSections';

/** Mirrors the `Factory reset` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Factory reset';
const PAGE_DESCRIPTION =
  'Erase every user and all application data, returning this deployment to a fresh install.';

/** The `Database Backup` card's path in `config/adminSections.tsx`. */
const BACKUP_PAGE_PATH = '/admin/settings/db-backup';

/**
 * Every category a reset deletes, in display order. `key` is the summary /
 * result field; the list renders even when the count is unknown.
 */
const DELETED_CATEGORIES: Array<{
  key: keyof FactoryResetSummary & string;
  singular: string;
  plural: string;
  /** Shown when the count is unknown (loading failed or key missing). */
  fallback: string;
  detail: string;
}> = [
  {
    key: 'otherUsers',
    singular: 'other user and their account',
    plural: 'other users and their accounts',
    fallback: 'Every other user and their account',
    detail: 'Their sign-ins, sessions, access tokens and AI keys. Nobody else can sign in afterwards.',
  },
  {
    key: 'workouts',
    singular: 'workout',
    plural: 'workouts',
    fallback: 'Workouts',
    detail: 'Every logged workout, set and personal record, for everyone, including you.',
  },
  {
    key: 'programs',
    singular: 'program',
    plural: 'programs',
    fallback: 'Programs',
    detail: 'Training programs and plans.',
  },
  {
    key: 'trainingRuns',
    singular: 'AI training run',
    plural: 'AI training runs',
    fallback: 'AI training runs',
    detail: 'Plan-generation and adaptation runs.',
  },
  {
    key: 'gyms',
    singular: 'gym',
    plural: 'gyms',
    fallback: 'Gyms',
    detail: 'Every gym and its equipment list.',
  },
  {
    key: 'measurements',
    singular: 'measurement',
    plural: 'measurements',
    fallback: 'Measurements',
    detail: 'Health profiles, measurements and check-ins.',
  },
  {
    key: 'healthDocuments',
    singular: 'health document',
    plural: 'health documents',
    fallback: 'Health documents',
    detail: 'Lab reports and body-metric photos, with their files.',
  },
  {
    key: 'customExercises',
    singular: 'custom exercise',
    plural: 'custom exercises',
    fallback: 'Custom exercises',
    detail: 'Exercises users added to the library. The built-in catalog stays.',
  },
  {
    key: 'customEquipment',
    singular: 'custom equipment item',
    plural: 'custom equipment items',
    fallback: 'Custom equipment',
    detail: 'Equipment users added. The built-in catalog stays.',
  },
  {
    key: 'storageObjects',
    singular: 'file in storage',
    plural: 'files in storage',
    fallback: 'Files in storage',
    detail: 'Uploaded photos and profile images. Database backup archives are kept.',
  },
  {
    key: 'aiRuns',
    singular: 'AI run',
    plural: 'AI runs',
    fallback: 'AI runs',
    detail: 'AI request history and usage records.',
  },
  {
    key: 'jobs',
    singular: 'job in the job history',
    plural: 'jobs in the job history',
    fallback: 'Job history',
    detail: 'Background job records.',
  },
  {
    key: 'notifications',
    singular: 'notification',
    plural: 'notifications',
    fallback: 'Notifications',
    detail: 'Every user’s notification history.',
  },
  {
    key: 'broadcasts',
    singular: 'broadcast',
    plural: 'broadcasts',
    fallback: 'Broadcasts',
    detail: 'Admin broadcasts and their delivery records.',
  },
  {
    key: 'allowlistEntries',
    singular: 'allowlist entry',
    plural: 'allowlist entries',
    fallback: 'Allowlist entries',
    detail: 'Pre-authorized email addresses.',
  },
];

const KEPT: Array<{ primary: string; secondary: string }> = [
  {
    primary: 'Your admin account and session',
    secondary: 'You stay signed in and can start using the fresh install straight away.',
  },
  { primary: 'Roles and permissions', secondary: 'The role definitions are not changed.' },
  {
    primary: 'System settings and integrations',
    secondary: 'Storage, AI, email, push notifications and telemetry configuration.',
  },
  {
    primary: 'The exercise and equipment catalog',
    secondary: 'The built-in library every user starts from (custom additions are deleted).',
  },
  { primary: 'Worker nodes', secondary: 'Registered nodes stay registered.' },
  {
    primary: 'Database backups',
    secondary: 'Existing backups are kept, so you can restore from one.',
  },
  {
    primary: 'The security audit log',
    secondary: 'Kept for security; it records that this reset happened and who ran it.',
  },
];

const STORAGE_RESULT_KEYS = new Set(['storageObjectsDeleted', 'storageObjectsFailed']);

/**
 * Result fields with no summary twin, labelled for people. Anything else the
 * API reports falls back to a humanized key ("worker nodes reassigned").
 */
const RESULT_ONLY_LABELS: Record<string, { singular: string; plural: string }> = {
  usersDeleted: { singular: 'user account', plural: 'user accounts' },
};

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The non-zero counts a finished reset reports, labelled for people. */
function resultLines(result: FactoryResetResult | null | undefined): string[] {
  if (!result) return [];
  const lines: string[] = [];
  const known = new Set<string>();
  for (const category of DELETED_CATEGORIES) {
    known.add(category.key);
    // Storage is reported by the two storage fields below, not the summary key.
    if (category.key === 'storageObjects') continue;
    const value = result[category.key];
    if (typeof value === 'number' && value > 0) {
      lines.push(countLabel(value, category.singular, category.plural));
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (known.has(key) || STORAGE_RESULT_KEYS.has(key)) continue;
    if (typeof value === 'number' && value > 0) {
      const label = RESULT_ONLY_LABELS[key];
      lines.push(
        label
          ? countLabel(value, label.singular, label.plural)
          : `${value.toLocaleString()} ${humanizeKey(key)}`,
      );
    }
  }
  const stored = result.storageObjectsDeleted;
  if (typeof stored === 'number' && stored > 0) {
    lines.push(countLabel(stored, 'file in storage', 'files in storage'));
  }
  return lines;
}

export default function FactoryResetPage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  // Optional: the provider is mounted in the shell, not necessarily in tests.
  const notifications = useContext(NotificationContext);
  const { summary, isLoading: summaryLoading, error: summaryError, refresh: refreshSummary } =
    useFactoryResetSummary();
  const { phase, job, error: resetError, start, reset } = useFactoryReset();

  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState('');

  const titleId = useId();
  const descriptionId = useId();
  const phraseHelpId = useId();

  const busy = phase === 'starting' || phase === 'running';
  const canConfirm = acknowledged && phrase === FACTORY_RESET_CONFIRMATION_PHRASE && !busy;

  const closeDialog = () => {
    // The dialog cannot be dismissed while the job runs (MUI 9 has no
    // `disableEscapeKeyDown`; Escape and backdrop clicks both land here).
    if (busy) return;
    setOpen(false);
    setAcknowledged(false);
    setPhrase('');
    reset();
  };

  const clearClientCaches = () => {
    // The admin's own records went too. No query cache in this app: pages
    // fetch on mount. Drop the few module-level and session caches that would
    // otherwise outlive the data, and refresh the shell's own state.
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
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        <Alert severity="warning" sx={{ mb: 3 }}>
          <AlertTitle>Take a database backup first</AlertTitle>
          A factory reset cannot be undone. A backup is the only way back: take one on the{' '}
          <Link component={RouterLink} to={BACKUP_PAGE_PATH}>
            Database Backup
          </Link>{' '}
          page before you continue, and check that it finished.
        </Alert>

        <Paper
          component="section"
          aria-labelledby="factory-reset-danger-heading"
          variant="outlined"
          sx={{ borderColor: 'error.main', borderWidth: 2, p: { xs: 2, sm: 3 } }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <WarningAmberIcon color="error" aria-hidden />
            <Typography
              id="factory-reset-danger-heading"
              variant="h5"
              component="h2"
              color="error"
            >
              Danger Zone
            </Typography>
          </Box>
          <Typography sx={{ mb: 2 }}>
            This erases the <strong>whole application for everyone</strong>: every other user
            and their account, and every workout, program, gym, measurement and file, including
            your own. <strong>It cannot be undone.</strong>
          </Typography>

          <Typography variant="h6" component="h3" id="factory-reset-deleted-heading">
            What will be deleted
          </Typography>
          {summaryError && (
            <Alert severity="warning" sx={{ my: 1 }}>
              Could not load how much data this deployment holds. Everything below will still be
              deleted.
            </Alert>
          )}
          <List dense aria-labelledby="factory-reset-deleted-heading" sx={{ mb: 2 }}>
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
                primary = category.fallback;
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
              Counting this deployment’s data…
            </Typography>
          )}

          <Typography variant="h6" component="h3" id="factory-reset-stays-heading">
            What stays
          </Typography>
          <List dense aria-labelledby="factory-reset-stays-heading" sx={{ mb: 2 }}>
            {KEPT.map((item) => (
              <ListItem key={item.primary} disableGutters>
                <ListItemText primary={item.primary} secondary={item.secondary} />
              </ListItem>
            ))}
          </List>

          <Button
            variant="contained"
            color="error"
            startIcon={<DeleteForeverIcon />}
            onClick={() => setOpen(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Factory reset…
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
            {phase === 'succeeded'
              ? 'The factory reset is complete'
              : 'Factory reset this deployment?'}
          </DialogTitle>

          {phase === 'succeeded' ? (
            <>
              <DialogContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <CheckCircleIcon color="success" aria-hidden />
                  <DialogContentText id={descriptionId}>
                    The reset finished. This deployment is back to a fresh install; your admin
                    account, settings and integrations are still here.
                  </DialogContentText>
                </Box>
                {removed.length > 0 && (
                  <>
                    <Typography variant="subtitle2" component="h3" id="factory-reset-removed-heading">
                      Removed
                    </Typography>
                    <List dense aria-labelledby="factory-reset-removed-heading">
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
                    {countLabel(storageFailed, 'file', 'files')} could not be removed from
                    storage. The records are gone; the leftover files can be cleaned up in the
                    storage provider.
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
                    navigate(ADMIN_HUB_PATH, { replace: true });
                  }}
                >
                  Back to admin settings
                </Button>
              </DialogActions>
            </>
          ) : busy ? (
            <DialogContent>
              <DialogContentText id={descriptionId} role="status" sx={{ mb: 2 }}>
                Erasing all application data… Keep this page open; this can take a minute.
              </DialogContentText>
              <LinearProgress aria-label="Erasing all application data" color="error" />
            </DialogContent>
          ) : (
            <>
              <DialogContent>
                <DialogContentText id={descriptionId} sx={{ mb: 2 }}>
                  This permanently deletes every other user and all application data for
                  everyone, including your own workouts, programs and files. There is no undo.
                  Make sure you have a database backup.
                </DialogContentText>

                {phase === 'failed' && resetError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    <AlertTitle>The factory reset did not finish</AlertTitle>
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
                  label="I understand this permanently deletes all users and all data for everyone and cannot be undone"
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
                    {FACTORY_RESET_CONFIRMATION_PHRASE}
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
                  {phase === 'failed' ? 'Try again' : 'Factory reset'}
                </Button>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Box>
    </Container>
  );
}
