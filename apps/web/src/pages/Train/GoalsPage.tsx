/**
 * Goals (`/train/goals`), #268 (epic #260). A Train destination, not a
 * settings page.
 *
 * The caller's activity goals by status (Active / Paused / Archived: three
 * views of one list, so tabs), a New goal flow (a template from
 * `GET /api/goals/templates`, or a custom goal), Edit (`PATCH` with
 * `If-Match`), Pause / Resume / Archive, and each goal's history (Hit / Missed
 * per period, the current streak).
 *
 * `goals:read` reaches the route (App.tsx); `goals:write` offers every write.
 * The API enforces both and decides limits (`409 GOAL_LIMIT_REACHED`) and
 * staleness (`412`); both are explained in words.
 */
import { useId, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Collapse,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowBack as BackIcon,
  Archive as ArchiveIcon,
  Edit as EditIcon,
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useGoalTemplates, useGoals } from '../../hooks/useGoals';
import { useDistanceUnit } from '../../hooks/useDistanceUnit';
import {
  GOAL_STATUSES,
  createGoal,
  goalErrorMessage,
  isGoalOutdated,
  transitionGoal,
  updateGoal,
  type CreateGoalInput,
  type Goal,
  type GoalStatus,
  type GoalTransition,
} from '../../services/goals';
import { activityLabel, formatGoalTarget, type DistanceUnit } from '../../utils/goalFormat';
import { GoalFormDialog, goalPatch } from '../../components/goals/GoalFormDialog';
import { GoalHistory } from '../../components/goals/GoalHistory';

export const GOALS_SUBTITLE = 'Set simple targets, like walking four times a week, and check in as you go.';

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

const EMPTY_TEXT: Record<GoalStatus, string> = {
  active: 'No active goals yet.',
  paused: 'No paused goals.',
  archived: 'No archived goals.',
};

const TRANSITION_DONE: Record<GoalTransition, string> = {
  pause: 'paused',
  resume: 'resumed',
  archive: 'archived',
};

function GoalItem({
  goal,
  unit,
  canWrite,
  busy,
  onEdit,
  onTransition,
  onArchive,
}: {
  goal: Goal;
  unit: DistanceUnit;
  canWrite: boolean;
  busy: boolean;
  onEdit: () => void;
  onTransition: (action: GoalTransition) => void;
  onArchive: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const headingId = useId();
  const historyId = useId();
  return (
    <Card component="li" variant="outlined" aria-labelledby={headingId} data-testid={`goal-${goal.id}`}>
      <CardContent sx={{ pb: 1 }}>
        <Typography id={headingId} variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
          {goal.title}
        </Typography>
        <Typography color="text.secondary">{formatGoalTarget(goal, unit)}</Typography>
        <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
          <Chip size="small" label={activityLabel(goal)} />
          {goal.status !== 'active' && <Chip size="small" variant="outlined" label={STATUS_LABELS[goal.status]} />}
        </Box>
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap', gap: 0.5, px: 2, pb: 1.5 }}>
        <Button
          size="small"
          startIcon={<HistoryIcon />}
          aria-expanded={showHistory}
          aria-controls={historyId}
          onClick={() => setShowHistory((v) => !v)}
          sx={{ minHeight: 44 }}
        >
          History
        </Button>
        {canWrite && goal.status !== 'archived' && (
          <>
            <Button
              size="small"
              startIcon={<EditIcon />}
              onClick={onEdit}
              disabled={busy}
              aria-label={`Edit ${goal.title}`}
              sx={{ minHeight: 44 }}
            >
              Edit
            </Button>
            {goal.status === 'active' ? (
              <Button
                size="small"
                startIcon={<PauseIcon />}
                onClick={() => onTransition('pause')}
                disabled={busy}
                aria-label={`Pause ${goal.title}`}
                sx={{ minHeight: 44 }}
              >
                Pause
              </Button>
            ) : (
              <Button
                size="small"
                startIcon={<ResumeIcon />}
                onClick={() => onTransition('resume')}
                disabled={busy}
                aria-label={`Resume ${goal.title}`}
                sx={{ minHeight: 44 }}
              >
                Resume
              </Button>
            )}
            <Button
              size="small"
              color="inherit"
              startIcon={<ArchiveIcon />}
              onClick={onArchive}
              disabled={busy}
              aria-label={`Archive ${goal.title}`}
              sx={{ minHeight: 44 }}
            >
              Archive
            </Button>
          </>
        )}
      </CardActions>
      <Collapse in={showHistory} unmountOnExit>
        <Box sx={{ px: 2, pb: 2 }}>
          <GoalHistory goal={goal} unit={unit} id={historyId} />
        </Box>
      </Collapse>
    </Card>
  );
}

export default function GoalsPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('goals:write');
  const unit = useDistanceUnit();
  const [status, setStatus] = useState<GoalStatus>('active');
  const { goals, isLoading, error, refresh } = useGoals(status);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const templates = useGoalTemplates({ enabled: canWrite && formOpen && editingId === null });
  const [archiving, setArchiving] = useState<Goal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const editing = editingId ? (goals.find((g) => g.id === editingId) ?? null) : null;

  const openCreate = () => {
    setEditingId(null);
    setFormOpen(true);
  };
  const openEdit = (goal: Goal) => {
    setEditingId(goal.id);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
  };

  const submit = async (input: CreateGoalInput) => {
    if (editing) {
      const patch = goalPatch(editing, input);
      if (Object.keys(patch).length > 0) await updateGoal(editing.id, editing.version, patch);
      setNotice(`Saved ${input.title}.`);
    } else {
      await createGoal(input);
      setNotice(`Created ${input.title}.`);
    }
    setActionError(null);
    closeForm();
    if (!editing && status !== 'active') setStatus('active');
    else await refresh();
  };

  const transition = async (goal: Goal, action: GoalTransition) => {
    setBusyId(goal.id);
    setActionError(null);
    setNotice(null);
    try {
      await transitionGoal(goal.id, action);
      setNotice(`${goal.title} ${TRANSITION_DONE[action]}.`);
      await refresh();
    } catch (err) {
      setActionError(goalErrorMessage(err, `Could not ${action} the goal.`));
      // Paused, resumed or archived elsewhere: show where it is now.
      if (isGoalOutdated(err)) await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const confirmArchive = async () => {
    const goal = archiving;
    setArchiving(null);
    if (goal) await transition(goal, 'archive');
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/train" startIcon={<BackIcon />} size="small" sx={{ mb: 1, minHeight: 44 }}>
          Train
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Goals
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {GOALS_SUBTITLE}
        </Typography>
        {canWrite && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={openCreate}
            sx={{ mb: 2, minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
          >
            New goal
          </Button>
        )}

        <Box role="status" aria-live="polite">
          {notice && (
            <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>
              {notice}
            </Alert>
          )}
        </Box>
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)} sx={{ mb: 2 }}>
            {actionError}
          </Alert>
        )}

        <Tabs
          value={status}
          onChange={(_, value: GoalStatus) => setStatus(value)}
          aria-label="Goal status"
          variant="fullWidth"
          sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
        >
          {GOAL_STATUSES.map((s) => (
            <Tab key={s} value={s} label={STATUS_LABELS[s]} id={`goals-tab-${s}`} aria-controls="goals-panel" />
          ))}
        </Tabs>

        <Box role="tabpanel" id="goals-panel" aria-labelledby={`goals-tab-${status}`}>
          {isLoading && goals.length === 0 ? (
            <Stack spacing={2} data-testid="goals-skeleton">
              <Skeleton variant="rounded" height={96} />
              <Skeleton variant="rounded" height={96} />
            </Stack>
          ) : error && goals.length === 0 ? (
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
          ) : goals.length === 0 ? (
            <Box>
              <Typography color="text.secondary" sx={{ mb: 1 }}>
                {EMPTY_TEXT[status]}
              </Typography>
              {status === 'active' && canWrite && (
                <Button variant="outlined" size="small" onClick={openCreate}>
                  Set your first goal
                </Button>
              )}
            </Box>
          ) : (
            <Stack component="ul" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {goals.map((goal) => (
                <GoalItem
                  key={goal.id}
                  goal={goal}
                  unit={unit}
                  canWrite={canWrite}
                  busy={busyId === goal.id}
                  onEdit={() => openEdit(goal)}
                  onTransition={(action) => void transition(goal, action)}
                  onArchive={() => setArchiving(goal)}
                />
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      {canWrite && (
        <GoalFormDialog
          open={formOpen}
          goal={editing}
          templates={templates.templates}
          templatesLoading={templates.isLoading}
          unit={unit}
          onClose={closeForm}
          onSubmit={submit}
          onStale={refresh}
        />
      )}

      <Dialog open={archiving !== null} onClose={() => setArchiving(null)} aria-labelledby="archive-goal-title">
        <DialogTitle id="archive-goal-title">Archive this goal?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {archiving?.title} stops counting and moves to Archived. Its history is kept.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setArchiving(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void confirmArchive()}>
            Archive
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
