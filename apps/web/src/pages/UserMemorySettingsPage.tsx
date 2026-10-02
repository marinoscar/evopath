/**
 * Settings → Memory (`/settings/memory`), #325; docs/specs/user-memory.md.
 *
 * What the AI Coach remembers about the caller: a one-time disclosure, the
 * caller's three memory preferences, and every active memory grouped by
 * category, each of which can be pinned, edited or deleted (with Undo). A new
 * memory can be added by hand; all of them can be deleted at once.
 *
 * A REGISTRY CARD of its own (`USER_SETTINGS_SECTIONS`, AI group, appended
 * last, `permission: 'ai:use'`, `feature: 'ai'`); the route wraps it in
 * `RequirePermission('ai:use')` and `RequireAiEnabled`, the same gate as
 * `/settings/coach`. The `ai:use` re-check below is defence in depth.
 *
 * THE API DECIDES. Limits, whether memory is on (deployment policy AND the
 * caller's switch), what counts as health-related and the order of the list
 * are the server's. The page renders `GET /api/memories` and maps refusals
 * (`409 MEMORY_LIMIT_REACHED`, `403 MEMORY_DISABLED`, `400` validation) to a
 * sentence; nothing here calls a model.
 */
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  FormHelperText,
  IconButton,
  List,
  ListItem,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { useMemories } from '../hooks/useMemories';
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_CONTENT_MAX,
  MEMORY_SOURCE_LABELS,
  isMemoryCategory,
  memoryCategoryLabel,
  type MemoryCategory,
  type MemoryUserSettingsView,
  type UserMemory,
} from '../services/memories';
import { formatRelativeTime } from '../utils/relativeTime';

/** Mirrors the `Memory` card in `config/userSettingsSections.tsx`, word for word. */
export const MEMORY_PAGE_TITLE = 'Memory';
export const MEMORY_PAGE_DESCRIPTION = 'What your coach remembers about you';

export const MEMORY_DISCLOSURE =
  "Your coach remembers useful things you share — like your name, preferences and training limits — so you don't have to repeat yourself. You can see, edit or delete anything here, or turn memory off.";
export const MEMORY_POLICY_OFF_MESSAGE =
  'Your administrator has switched memory off for this deployment. Your coach does not use or save memories until it is switched back on. You can still review and delete what is stored.';
export const MEMORY_AUTO_EXTRACT_POLICY_OFF_MESSAGE =
  'Your administrator has switched off learning from conversations. Your coach only remembers what you add here or ask it to remember.';
export const MEMORY_USER_OFF_MESSAGE =
  'Memory is off. Your coach does not use or save memories. Turn it on to add new ones.';
export const MEMORY_EMPTY_MESSAGE =
  'Your coach has not remembered anything yet. Tell it something in chat, like "remember that I train before work", or add a memory below.';

function Section({
  id,
  title,
  description,
  children,
  action,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Paper component="section" aria-labelledby={id} sx={{ p: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 1,
          mb: description ? 0.5 : 2,
        }}
      >
        <Typography id={id} variant="h6" component="h2">
          {title}
        </Typography>
        {action}
      </Box>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>
      )}
      {children}
    </Paper>
  );
}

// -----------------------------------------------------------------------------
// One memory
// -----------------------------------------------------------------------------

interface MemoryItemProps {
  memory: UserMemory;
  busy: boolean;
  onTogglePin: (memory: UserMemory) => void;
  onSave: (memory: UserMemory, content: string, category: MemoryCategory) => Promise<boolean>;
  onDelete: (memory: UserMemory) => void;
}

function MemoryItem({ memory, busy, onTogglePin, onSave, onDelete }: MemoryItemProps) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [category, setCategory] = useState<MemoryCategory>(memory.category);
  const contentId = useId();
  const editId = useId();
  const trimmed = content.trim();
  const tooLong = content.length > MEMORY_CONTENT_MAX;
  const changed = trimmed !== memory.content || category !== memory.category;

  const startEdit = () => {
    setContent(memory.content);
    setCategory(memory.category);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || tooLong || !changed) return;
    if (await onSave(memory, trimmed, category)) setEditing(false);
  };

  const sourceLabel = MEMORY_SOURCE_LABELS[memory.source] ?? MEMORY_SOURCE_LABELS.explicit;

  return (
    <ListItem
      disableGutters
      data-testid={`memory-${memory.id}`}
      aria-labelledby={contentId}
      sx={{ display: 'block', py: 1.5, borderTop: 1, borderColor: 'divider' }}
    >
      {editing ? (
        <Box component="form" onSubmit={(event) => void save(event)} noValidate>
          <Stack spacing={1.5}>
            <TextField
              id={`${editId}-content`}
              label="Memory"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              multiline
              minRows={2}
              fullWidth
              size="small"
              error={tooLong || !trimmed}
              helperText={
                tooLong
                  ? `Keep it under ${MEMORY_CONTENT_MAX} characters.`
                  : !trimmed
                    ? 'A memory cannot be empty.'
                    : `${content.length}/${MEMORY_CONTENT_MAX}`
              }
              autoFocus
            />
            <TextField
              select
              id={`${editId}-category`}
              label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value as MemoryCategory)}
              size="small"
              sx={{ maxWidth: { sm: 280 } }}
            >
              {MEMORY_CATEGORIES.map((value) => (
                <MenuItem key={value} value={value}>
                  {MEMORY_CATEGORY_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={busy || !trimmed || tooLong || !changed} sx={{ minHeight: 44 }}>
                Save
              </Button>
              <Button onClick={() => setEditing(false)} disabled={busy} sx={{ minHeight: 44 }}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={contentId} sx={{ overflowWrap: 'anywhere' }}>
              {memory.content}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip size="small" variant="outlined" label={sourceLabel} />
              {memory.sensitivity === 'health' && <Chip size="small" color="warning" variant="outlined" label="Health" />}
              {memory.pinned && <Chip size="small" color="primary" variant="outlined" label="Pinned" />}
              <Typography variant="caption" color="text.secondary">
                {formatRelativeTime(memory.updatedAt)}
              </Typography>
            </Stack>
          </Box>
          <Stack direction="row" spacing={0} sx={{ flexShrink: 0 }}>
            <Tooltip title={memory.pinned ? 'Unpin' : 'Pin'}>
              <span>
                <IconButton
                  aria-label={memory.pinned ? 'Unpin' : 'Pin'}
                  aria-pressed={memory.pinned}
                  onClick={() => onTogglePin(memory)}
                  disabled={busy}
                  sx={{ width: 44, height: 44 }}
                >
                  {memory.pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Edit">
              <span>
                <IconButton aria-label="Edit" onClick={startEdit} disabled={busy} sx={{ width: 44, height: 44 }}>
                  <EditOutlinedIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Delete">
              <span>
                <IconButton aria-label="Delete" onClick={() => onDelete(memory)} disabled={busy} sx={{ width: 44, height: 44 }}>
                  <DeleteOutlineIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Box>
      )}
    </ListItem>
  );
}

// -----------------------------------------------------------------------------
// The page
// -----------------------------------------------------------------------------

export default function UserMemorySettingsPage() {
  const { hasPermission } = usePermissions();
  const memories = useMemories();
  const { view, isLoading, loadError, isSaving } = memories;

  const [optimistic, setOptimistic] = useState<Partial<MemoryUserSettingsView>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [addContent, setAddContent] = useState('');
  const [addCategory, setAddCategory] = useState<MemoryCategory>('preference');
  const [addError, setAddError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<UserMemory | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const grouped = useMemo(() => {
    const groups = new Map<MemoryCategory, UserMemory[]>();
    for (const item of view?.items ?? []) {
      const category = isMemoryCategory(item.category) ? item.category : 'other';
      const list = groups.get(category) ?? [];
      list.push(item);
      groups.set(category, list);
    }
    return MEMORY_CATEGORIES.filter((category) => groups.has(category)).map((category) => ({
      category,
      // Pinned first; otherwise the server's order.
      items: [...(groups.get(category) ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    }));
  }, [view?.items]);

  if (!hasPermission('ai:use')) {
    return <Navigate to="/" replace />;
  }

  const settings: MemoryUserSettingsView | null = view ? { ...view.settings, ...optimistic } : null;
  const policy = view?.policy ?? null;
  const policyOn = policy?.enabled ?? false;
  const memoryOn = policyOn && (settings?.enabled ?? false);
  const canAdd = memoryOn && !isSaving;
  const active = view?.counts.active ?? view?.items.length ?? 0;
  const atLimit = !!policy && active >= policy.maxPerUser;

  const saveSetting = async (patch: Partial<MemoryUserSettingsView>) => {
    setActionError(null);
    setOptimistic((prev) => ({ ...prev, ...patch }));
    const result = await memories.saveSettings(patch);
    setOptimistic((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch) as Array<keyof MemoryUserSettingsView>) delete next[key];
      return next;
    });
    if (!result.ok) setActionError(result.message);
  };

  const acknowledgeDisclosure = () => void saveSetting({ disclosureSeenAt: new Date().toISOString() });

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const content = addContent.trim();
    if (!content || content.length > MEMORY_CONTENT_MAX) return;
    setAddError(null);
    const result = await memories.add({ content, category: addCategory });
    if (result.ok) {
      setAddContent('');
      setToast('Memory added');
    } else {
      setAddError(result.message);
    }
  };

  const handleTogglePin = async (memory: UserMemory) => {
    setActionError(null);
    const result = await memories.update(memory.id, { pinned: !memory.pinned });
    if (!result.ok) setActionError(result.message);
  };

  const handleSave = async (memory: UserMemory, content: string, category: MemoryCategory) => {
    setActionError(null);
    const input: { content?: string; category?: MemoryCategory } = {};
    if (content !== memory.content) input.content = content;
    if (category !== memory.category) input.category = category;
    const result = await memories.update(memory.id, input);
    if (!result.ok) {
      setActionError(result.message);
      return false;
    }
    setToast('Memory updated');
    return true;
  };

  const handleDelete = async (memory: UserMemory) => {
    setActionError(null);
    const result = await memories.remove(memory.id);
    if (result.ok) setDeleted(memory);
    else setActionError(result.message);
  };

  const handleUndo = async () => {
    const memory = deleted;
    setDeleted(null);
    if (!memory) return;
    const result = await memories.restore(memory.id);
    if (result.ok) setToast('Memory restored');
    else setActionError(result.message);
  };

  const handleDeleteAll = async () => {
    setConfirmAll(false);
    setActionError(null);
    const result = await memories.removeAll();
    if (result.ok) setToast('All memories deleted');
    else setActionError(result.message);
  };

  const addTooLong = addContent.length > MEMORY_CONTENT_MAX;

  return (
    <Container maxWidth="md" sx={{ px: { xs: 2, sm: 3 } }}>
      <Box sx={{ py: { xs: 2, md: 4 }, minWidth: 0 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {MEMORY_PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {MEMORY_PAGE_DESCRIPTION}. Your coach uses these to personalise its replies and plans.
        </Typography>

        {isLoading && !view && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }} role="status" aria-label="Loading memories">
            <CircularProgress />
          </Box>
        )}

        {loadError && !view && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void memories.refresh()}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        {view && settings && policy && (
          <Stack spacing={3}>
            {!settings.disclosureSeenAt && (
              <Alert
                severity="info"
                data-testid="memory-disclosure"
                action={
                  <Button color="inherit" size="small" onClick={acknowledgeDisclosure} disabled={isSaving}>
                    Got it
                  </Button>
                }
              >
                <AlertTitle>How memory works</AlertTitle>
                {MEMORY_DISCLOSURE}
              </Alert>
            )}

            {!policyOn && (
              <Alert severity="warning" data-testid="memory-policy-off">
                {MEMORY_POLICY_OFF_MESSAGE}
              </Alert>
            )}

            {actionError && (
              <Alert severity="error" role="alert" onClose={() => setActionError(null)}>
                {actionError}
              </Alert>
            )}

            <Section id="memory-preferences-title" title="Preferences">
              <Stack spacing={2}>
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={settings.enabled}
                        disabled={!policyOn || isSaving}
                        onChange={(e) => void saveSetting({ enabled: e.target.checked })}
                      />
                    }
                    label="Memory on"
                  />
                  <FormHelperText>Let your coach use and save memories about you.</FormHelperText>
                </Box>
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={settings.autoExtract && policy.autoExtract}
                        disabled={!memoryOn || !policy.autoExtract || isSaving}
                        onChange={(e) => void saveSetting({ autoExtract: e.target.checked })}
                      />
                    }
                    label="Learn from conversations"
                  />
                  <FormHelperText>
                    {policyOn && !policy.autoExtract
                      ? MEMORY_AUTO_EXTRACT_POLICY_OFF_MESSAGE
                      : 'Your coach picks up useful facts from your chats in the background. Otherwise it only remembers what you add or ask it to remember.'}
                  </FormHelperText>
                </Box>
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={settings.allowHealth}
                        disabled={!memoryOn || isSaving}
                        onChange={(e) => void saveSetting({ allowHealth: e.target.checked })}
                      />
                    }
                    label="Allow health-related memories"
                  />
                  <FormHelperText>
                    Injuries, conditions and limits your coach should train around. Turn off to keep health details out
                    of memory.
                  </FormHelperText>
                </Box>
                {policyOn && !settings.enabled && (
                  <Alert severity="info" data-testid="memory-user-off">
                    {MEMORY_USER_OFF_MESSAGE}
                  </Alert>
                )}
              </Stack>
            </Section>

            <Section
              id="memory-list-title"
              title="Your memories"
              action={
                <Typography variant="body2" color="text.secondary" data-testid="memory-count">
                  {active} of {policy.maxPerUser}
                </Typography>
              }
            >
              <Box component="form" onSubmit={(event) => void handleAdd(event)} noValidate aria-labelledby="memory-add-title" sx={{ mb: 2 }}>
                <Typography id="memory-add-title" variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 1 }}>
                  Add a memory
                </Typography>
                <Stack spacing={1.5}>
                  <TextField
                    id="memory-add-content"
                    label="What should your coach remember?"
                    value={addContent}
                    onChange={(e) => setAddContent(e.target.value)}
                    multiline
                    minRows={2}
                    fullWidth
                    size="small"
                    disabled={!memoryOn}
                    error={addTooLong}
                    helperText={
                      addTooLong
                        ? `Keep it under ${MEMORY_CONTENT_MAX} characters.`
                        : 'For example: "I prefer morning workouts" or "Avoid overhead pressing, my left shoulder is sore".'
                    }
                  />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'flex-start' } }}>
                    <TextField
                      select
                      id="memory-add-category"
                      label="Category"
                      value={addCategory}
                      onChange={(e) => setAddCategory(e.target.value as MemoryCategory)}
                      size="small"
                      disabled={!memoryOn}
                      sx={{ minWidth: { sm: 240 } }}
                    >
                      {MEMORY_CATEGORIES.map((value) => (
                        <MenuItem key={value} value={value}>
                          {MEMORY_CATEGORY_LABELS[value]}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Button
                      type="submit"
                      variant="contained"
                      disabled={!canAdd || !addContent.trim() || addTooLong || atLimit}
                      sx={{ minHeight: 40 }}
                    >
                      Add memory
                    </Button>
                  </Stack>
                  {atLimit && (
                    <FormHelperText>
                      You have reached the limit of {policy.maxPerUser} memories. Delete one to add another.
                    </FormHelperText>
                  )}
                  {addError && (
                    <Alert severity="error" role="alert" onClose={() => setAddError(null)}>
                      {addError}
                    </Alert>
                  )}
                </Stack>
              </Box>

              {grouped.length === 0 ? (
                <Box data-testid="memory-empty" sx={{ py: 3, textAlign: 'center' }}>
                  <Typography color="text.secondary">{MEMORY_EMPTY_MESSAGE}</Typography>
                </Box>
              ) : (
                <Stack spacing={2.5}>
                  {grouped.map(({ category, items }) => (
                    <Box
                      key={category}
                      component="section"
                      aria-labelledby={`memory-group-${category}`}
                      data-testid={`memory-group-${category}`}
                    >
                      <Typography
                        id={`memory-group-${category}`}
                        variant="subtitle1"
                        component="h3"
                        sx={{ fontWeight: 600 }}
                      >
                        {memoryCategoryLabel(category)} ({items.length})
                      </Typography>
                      <List disablePadding>
                        {items.map((memory) => (
                          <MemoryItem
                            key={`${memory.id}-${memory.updatedAt}`}
                            memory={memory}
                            busy={isSaving}
                            onTogglePin={(m) => void handleTogglePin(m)}
                            onSave={handleSave}
                            onDelete={(m) => void handleDelete(m)}
                          />
                        ))}
                      </List>
                    </Box>
                  ))}
                </Stack>
              )}
            </Section>

            <Section
              id="memory-delete-all-title"
              title="Delete all memories"
              description="Removes everything your coach remembers about you. Your workouts, plans and chat history are not affected."
            >
              <Button
                color="error"
                variant="outlined"
                onClick={() => setConfirmAll(true)}
                disabled={isSaving || active === 0}
                sx={{ minHeight: 44 }}
              >
                Delete all memories
              </Button>
            </Section>
          </Stack>
        )}

        <Dialog open={confirmAll} onClose={() => setConfirmAll(false)} aria-labelledby="memory-delete-all-dialog-title">
          <DialogTitle id="memory-delete-all-dialog-title">Delete all memories?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              Your coach will forget everything it remembers about you ({active}{' '}
              {active === 1 ? 'memory' : 'memories'}). This cannot be undone.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmAll(false)}>Cancel</Button>
            <Button color="error" variant="contained" onClick={() => void handleDeleteAll()}>
              Delete all
            </Button>
          </DialogActions>
        </Dialog>

        <Snackbar
          open={deleted !== null}
          autoHideDuration={8000}
          onClose={(_, reason) => {
            if (reason !== 'clickaway') setDeleted(null);
          }}
          message="Memory deleted"
          action={
            <Button color="inherit" size="small" onClick={() => void handleUndo()}>
              Undo
            </Button>
          }
        />
        <Snackbar
          open={toast !== null && deleted === null}
          autoHideDuration={3000}
          onClose={() => setToast(null)}
          message={toast ?? ''}
        />
      </Box>
    </Container>
  );
}
