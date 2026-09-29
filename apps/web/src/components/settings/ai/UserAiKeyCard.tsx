/**
 * One provider's key on `/settings/ai` — issue #430, epic #419.
 *
 * THE TYPED KEY LIVES ONLY IN THIS CARD'S OWN `useState('')`, and only until it
 * is saved. After a successful Save & verify the field is cleared and what
 * remains is the server's masked view (`hint`, `verifiedAt`) — the key itself
 * is never rendered again, because nothing the API returns carries it. The
 * field is a password box with `autoComplete="new-password"` so a password
 * manager never fills it with a credential the user did not type (the same
 * reasoning as the storage secret on `StorageConfigPage`).
 *
 * Save & verify is a PUT the server verifies BEFORE storing: a `400
 * AI_KEY_INVALID` means nothing was stored, and it is shown inline on this card
 * with the typed value left in place so the user can correct it.
 *
 * Test probes the typed key when there is one, otherwise the stored key; a
 * stored-key probe also refreshes the reachable-model count server-side, which
 * is what Re-check uses. The endpoint answers 200 either way — `success` is the
 * verdict.
 */
import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { AiProbeResult, UserAiKey } from '../../../services/ai';
import { aiCodeText, aiErrorText } from './aiErrorText';

export interface UserAiKeyCardProvider {
  id: string;
  displayName: string;
  hasOrgKey: boolean;
}

export interface UserAiKeyCardProps {
  provider: UserAiKeyCardProvider;
  /** The masked view for this provider; absent until the list has loaded. */
  keyView?: UserAiKey;
  /**
   * The organisation's key covers the caller for this provider: an org key
   * exists and either the policy is `byok_with_org_fallback` or the caller is
   * an AI administrator (`ai_config:write`, #593).
   */
  orgFallback: boolean;
  onSave: (provider: string, apiKey: string) => Promise<UserAiKey>;
  onTest: (provider: string, apiKey?: string) => Promise<AiProbeResult>;
  onRemove: (provider: string) => Promise<void>;
  /** Called after anything that can change which models are usable. */
  onChanged?: () => void;
}

type Busy = 'save' | 'test' | 'recheck' | 'remove' | null;

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function KeyStatus({ keyView }: { keyView?: UserAiKey }) {
  if (!keyView?.configured) {
    return <Chip size="small" label="Not configured" variant="outlined" />;
  }
  if (keyView.lastErrorCode) {
    return (
      <Stack sx={{ alignItems: 'center', flexWrap: 'wrap' }} direction="row" spacing={1} useFlexGap>
        <Chip size="small" color="error" label="Error" />
        <Typography variant="body2" color="error">
          {aiCodeText(keyView.lastErrorCode)}
        </Typography>
      </Stack>
    );
  }
  return (
    <Stack sx={{ alignItems: 'center', flexWrap: 'wrap' }} direction="row" spacing={1} useFlexGap>
      <Chip
        size="small"
        color={keyView.verifiedAt ? 'success' : 'default'}
        label={keyView.verifiedAt ? 'Verified' : 'Configured'}
      />
      {keyView.hint && (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {keyView.hint}
        </Typography>
      )}
      {keyView.verifiedAt && (
        <Typography variant="body2" color="text.secondary">
          verified {formatDate(keyView.verifiedAt)}
        </Typography>
      )}
    </Stack>
  );
}

function ProbeResult({ result }: { result: AiProbeResult }) {
  return (
    <Alert severity={result.success ? 'success' : 'error'} sx={{ mt: 2 }} role="status">
      <AlertTitle>{result.success ? 'The key works' : 'The key check failed'}</AlertTitle>
      <Box component="ul" sx={{ m: 0, pl: 2 }}>
        {result.checks.map((check) => (
          <li key={check.id}>
            {check.label}: {check.status}
            {check.status === 'failed'
              ? ` — ${aiCodeText(check.code)}`
              : check.detail
                ? ` — ${check.detail}`
                : ''}
          </li>
        ))}
      </Box>
    </Alert>
  );
}

export function UserAiKeyCard({
  provider,
  keyView,
  orgFallback,
  onSave,
  onTest,
  onRemove,
  onChanged,
}: UserAiKeyCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [probe, setProbe] = useState<AiProbeResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const configured = keyView?.configured === true;
  const fieldId = `ai-key-${provider.id}`;

  const reset = () => {
    setSaveError(null);
    setActionError(null);
    setProbe(null);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    reset();
    setBusy('save');
    try {
      await onSave(provider.id, apiKey.trim());
      // The key is gone from this component the moment the server has it.
      setApiKey('');
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setSaveError(aiErrorText(err, 'Failed to save the key'));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async (which: 'test' | 'recheck') => {
    reset();
    setBusy(which);
    try {
      const typed = which === 'test' ? apiKey.trim() : '';
      const result = await onTest(provider.id, typed || undefined);
      setProbe(result);
      if (result.usedStoredKey) onChanged?.();
    } catch (err) {
      setActionError(aiErrorText(err, 'Failed to test the key'));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    setConfirmOpen(false);
    reset();
    setBusy('remove');
    try {
      await onRemove(provider.id);
      onChanged?.();
    } catch (err) {
      setActionError(aiErrorText(err, 'Failed to remove the key'));
    } finally {
      setBusy(null);
    }
  };

  const spinner = (which: Busy) =>
    busy === which ? <CircularProgress size={16} color="inherit" /> : undefined;

  return (
    <Card component="section" aria-label={`${provider.displayName} key`}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography id={`${fieldId}-title`} variant="h6" component="h2" gutterBottom>
              {provider.displayName}
            </Typography>
            <KeyStatus keyView={keyView} />
          </Box>

          {orgFallback && (
            <Alert severity="info">
              Your organization provides a shared key. Adding your own key is optional; requests
              will use yours when present.
            </Alert>
          )}

          <Box
            component="form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <TextField
              id={fieldId}
              fullWidth
              type="password"
              label={configured ? 'Replace API key' : 'API key'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              placeholder={configured ? (keyView?.hint ?? '••••••••') : ''}
              error={Boolean(saveError)}
              helperText={
                saveError ??
                (configured
                  ? 'Leave blank to keep your saved key.'
                  : 'Paste the key from your provider account.')
              }
              disabled={busy !== null}
            />

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ flexWrap: 'wrap', mt: 2 }}
              useFlexGap
            >
              <Button
                type="submit"
                variant="contained"
                disabled={busy !== null || !apiKey.trim()}
                startIcon={spinner('save')}
              >
                Save &amp; verify
              </Button>
              <Button
                variant="outlined"
                onClick={() => void runTest('test')}
                disabled={busy !== null || (!configured && !apiKey.trim())}
                startIcon={spinner('test')}
              >
                Test
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={() => setConfirmOpen(true)}
                disabled={busy !== null || !configured}
                startIcon={spinner('remove')}
              >
                Remove
              </Button>
            </Stack>
          </Box>

          {saved && <Alert severity="success">Key verified and saved.</Alert>}
          {actionError && <Alert severity="error">{actionError}</Alert>}
          {probe && <ProbeResult result={probe} />}

          {configured && (
            <Stack sx={{ alignItems: 'center', flexWrap: 'wrap' }} direction="row" spacing={1} useFlexGap>
              <Typography variant="body2" color="text.secondary">
                {keyView?.reachableModelCount === 1
                  ? '1 model available with this key'
                  : `${keyView?.reachableModelCount ?? 0} models available with this key`}
              </Typography>
              <Button
                size="small"
                onClick={() => void runTest('recheck')}
                disabled={busy !== null}
                startIcon={spinner('recheck')}
              >
                Re-check
              </Button>
            </Stack>
          )}
        </Stack>
      </CardContent>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        aria-labelledby={`${fieldId}-remove-title`}
      >
        <DialogTitle id={`${fieldId}-remove-title`}>Remove your {provider.displayName} key?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Your key will be deleted. Requests to {provider.displayName} will
            {orgFallback ? " fall back to your organization's key." : ' stop working until you add a key again.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void handleRemove()}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
