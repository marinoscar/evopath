/**
 * "Use my health data in training plans" (H8, #192): a section of the
 * Training agents page (`/settings/ai/agents`), not a card or a tab of its own.
 *
 * Off by default. Turning it on first shows, in a confirmation dialog, exactly
 * what the API says is shared and never shared and which model provider will
 * process it; only Confirm sends `PUT .../consent { enabled: true }`. Turning
 * it off sends `{ enabled: false }` at once. While on, the section shows the
 * newest summary verbatim (the text the training agents receive), its state
 * and a "Refresh summary" button.
 *
 * Presentation only. The API decides what is shared, whether a model can
 * write the summary, staleness and refusals; `canWrite` (from
 * `health_data:write`) only disables controls, the API enforces it.
 */
import { useId, useState } from 'react';
import {
  Alert,
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
  FormControlLabel,
  List,
  ListItem,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { toAiErrorInfo } from '../../services/aiErrors';
import {
  HEALTH_SUMMARY_CONSENT_OFF,
  HEALTH_SUMMARY_NO_DATA,
  RUNNABLE_HEALTH_SUMMARY_STATES,
  type HealthSummaryView,
} from '../../services/healthSummary';
import type { RoleResolutionState } from '../../services/trainingAgents';
import { aiCodeText, aiErrorText } from '../settings/ai/aiErrorText';

export const HEALTH_SUMMARY_SWITCH_LABEL = 'Use my health data in training plans';

export const HEALTH_SUMMARY_NOT_MEDICAL_ADVICE =
  'This is not medical advice. The summary describes training-relevant observations only; ' +
  'discuss any flagged value with a clinician.';

export const HEALTH_SUMMARY_NO_RAW_DATA =
  'The training agents receive only the written summary: no raw lab values, readings or documents are sent to them.';

/** Why a summary cannot be written in a blocking model state. */
const MODEL_STATE_TEXT: Partial<Record<RoleResolutionState, string>> = {
  no_key: 'No model can write your health summary until you add an AI key for a provider in AI keys.',
  no_models: 'Your administrator has not made a model available for health summaries yet.',
  missing_capability:
    'The model your administrator assigned for health summaries cannot return structured output. Ask your administrator to choose another.',
  web_search_disabled: 'Your administrator has not finished setting up the model for health summaries.',
  ai_disabled: 'AI has been switched off by your administrator.',
};

const FAILURE_TEXT: Record<string, string> = {
  HEALTH_SUMMARY_POST_CHECK_REJECTED:
    "The model's answer did not pass the safety check, so it was not used.",
  HEALTH_SUMMARY_GENERATION_FAILED: 'Something went wrong while writing it.',
};

const REFRESH_REFUSAL_TEXT: Record<string, string> = {
  [HEALTH_SUMMARY_CONSENT_OFF]: `Turn on "${HEALTH_SUMMARY_SWITCH_LABEL}" first.`,
  [HEALTH_SUMMARY_NO_DATA]: 'There is no health data to summarise yet. Add some on the Health page first.',
};

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

function formatInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function failureText(code: string | null): string {
  if (code && FAILURE_TEXT[code]) return FAILURE_TEXT[code];
  return aiCodeText(code);
}

export interface HealthSummarySectionProps {
  view: HealthSummaryView | null;
  isLoading: boolean;
  error: string | null;
  /** `health_data:write`: without it every control is disabled. */
  canWrite: boolean;
  /** Provider id → display name, for the "processed by" sentence. */
  providerNames: Record<string, string>;
  onSetConsent: (enabled: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function HealthSummarySection({
  view,
  isLoading,
  error,
  canWrite,
  providerNames,
  onSetConsent,
  onRefresh,
}: HealthSummarySectionProps) {
  const titleId = useId();
  const dialogTitleId = useId();
  const dialogDescId = useId();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enabled = view?.enabled ?? false;
  const modelState = view?.sharing.modelState;
  const runnable = modelState !== undefined && RUNNABLE_HEALTH_SUMMARY_STATES.includes(modelState);
  const processor = view?.sharing.processor ?? null;
  const processorName = processor
    ? `${processor.displayName || processor.modelId} (${providerNames[processor.provider] ?? processor.provider})`
    : null;

  // Turning it off stays possible whatever the model state; turning it on needs a runnable model.
  const switchDisabled = !view || !canWrite || saving || (!enabled && !runnable);

  const sendConsent = async (next: boolean) => {
    setActionError(null);
    setNotice(null);
    setSaving(true);
    try {
      await onSetConsent(next);
      setNotice(
        next
          ? 'Turned on. Your summary is being written.'
          : 'Turned off. The summary is removed from future training runs.',
      );
    } catch (err) {
      setActionError(aiErrorText(err, 'Failed to save your choice'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      setConfirmOpen(true);
      return;
    }
    void sendConsent(false);
  };

  const handleConfirm = async () => {
    setConfirmOpen(false);
    await sendConsent(true);
  };

  const handleRefresh = async () => {
    setActionError(null);
    setNotice(null);
    setRefreshing(true);
    try {
      await onRefresh();
      setNotice('A new summary is being written.');
    } catch (err) {
      const { code } = toAiErrorInfo(err);
      setActionError(
        code && REFRESH_REFUSAL_TEXT[code] ? REFRESH_REFUSAL_TEXT[code] : aiErrorText(err, 'Failed to refresh your summary'),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const summary = view?.summary ?? null;
  const lastAttempt = view?.lastAttempt ?? null;
  const lastFailed =
    lastAttempt?.status === 'failed' && (summary === null || lastAttempt.version > summary.version);

  return (
    <Card component="section" aria-labelledby={titleId} data-testid="health-summary-section">
      <CardContent>
        <Typography id={titleId} variant="h6" component="h2" gutterBottom>
          Health data in training plans
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          When this is on, an AI model writes a short summary of your health data, and the planner and
          evaluator read that summary when they write and check your plan. {HEALTH_SUMMARY_NO_RAW_DATA}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {HEALTH_SUMMARY_NOT_MEDICAL_ADVICE}
        </Typography>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={28} aria-label="Loading your health summary" />
          </Box>
        ) : (
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}

            {view && (
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={enabled}
                      onChange={(event) => handleToggle(event.target.checked)}
                      disabled={switchDisabled}
                    />
                  }
                  label={HEALTH_SUMMARY_SWITCH_LABEL}
                />
                <Typography variant="body2" color="text.secondary">
                  {enabled
                    ? 'Turning this off stops new summaries and removes the summary from future training runs.'
                    : 'Off by default. You will see exactly what is shared before it is turned on.'}
                </Typography>
                {!canWrite && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    You do not have permission to change this setting.
                  </Typography>
                )}
              </Box>
            )}

            {view && !runnable && modelState && (
              <Alert severity="info">
                {MODEL_STATE_TEXT[modelState] ?? 'No model can write your health summary right now.'}
                {enabled ? ' Your existing summary is kept, but no new one can be written.' : ''}
              </Alert>
            )}

            {actionError && (
              <Alert severity="error" onClose={() => setActionError(null)}>
                {actionError}
              </Alert>
            )}
            {notice && (
              <Alert severity="success" onClose={() => setNotice(null)}>
                {notice}
              </Alert>
            )}

            {view && enabled && (
              <Box data-testid="health-summary-status">
                <Stack spacing={1.5}>
                  {view.pending && (
                    <Stack direction="row" spacing={1} role="status" sx={{ alignItems: 'center' }}>
                      <CircularProgress size={16} aria-hidden="true" />
                      <Typography variant="body2">Writing your summary…</Typography>
                    </Stack>
                  )}

                  {!view.hasData && (
                    <Typography variant="body2">
                      You have no health data to summarise yet. Add measurements, lab results or check-ins on
                      the{' '}
                      <RouterLink to="/health">Health page</RouterLink> and a summary will be written.
                    </Typography>
                  )}

                  {lastFailed && lastAttempt && (
                    <Alert severity="warning">
                      The last summary could not be written: {failureText(lastAttempt.errorCode)}
                      {summary ? ' The training agents keep using the previous summary.' : ''}
                    </Alert>
                  )}

                  {view.stale && !view.pending && view.hasData && (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip size="small" color="warning" variant="outlined" label="Out of date" />
                      <Typography variant="body2" color="text.secondary">
                        Your health data changed since this summary was written.
                      </Typography>
                    </Stack>
                  )}

                  {summary ? (
                    <Box>
                      <Typography variant="subtitle2" component="h3" gutterBottom>
                        Your summary
                      </Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
                        {summary.narrative}
                      </Typography>

                      {summary.trainingConsiderations.length > 0 && (
                        <>
                          <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
                            Training considerations
                          </Typography>
                          <List dense disablePadding aria-label="Training considerations">
                            {summary.trainingConsiderations.map((item, index) => (
                              <ListItem key={index} disableGutters sx={{ display: 'block', py: 0.75 }}>
                                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Chip
                                    size="small"
                                    color={item.severity === 'caution' ? 'warning' : 'default'}
                                    label={item.severity === 'caution' ? 'Caution' : 'Info'}
                                  />
                                  {item.conservative && (
                                    <Chip size="small" variant="outlined" label="Turns on conservative mode" />
                                  )}
                                </Stack>
                                <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                                  {item.text}
                                </Typography>
                              </ListItem>
                            ))}
                          </List>
                        </>
                      )}

                      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                        {summary.dataAsOf ? `Data as of ${formatDay(summary.dataAsOf)}. ` : ''}
                        Written {formatInstant(summary.createdAt)}
                        {summary.model ? ` by ${summary.model}` : ''}
                        {summary.provider ? ` (${providerNames[summary.provider] ?? summary.provider})` : ''}.
                      </Typography>
                    </Box>
                  ) : (
                    view.hasData &&
                    !view.pending &&
                    !lastFailed && (
                      <Typography variant="body2" color="text.secondary">
                        No summary has been written yet.
                      </Typography>
                    )
                  )}

                  <Box>
                    <Button
                      variant="outlined"
                      onClick={() => void handleRefresh()}
                      disabled={!canWrite || !runnable || refreshing || !view.hasData}
                    >
                      Refresh summary
                    </Button>
                  </Box>
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </CardContent>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescId}
      >
        <DialogTitle id={dialogTitleId}>Use your health data in training plans?</DialogTitle>
        <DialogContent>
          <DialogContentText id={dialogDescId} sx={{ mb: 2 }}>
            {processorName
              ? `${processorName} will process the data below to write a short summary.`
              : 'The AI model provider your administrator chose will process the data below to write a short summary.'}{' '}
            {HEALTH_SUMMARY_NO_RAW_DATA}
          </DialogContentText>

          <Typography variant="subtitle2" component="h3">
            What is shared
          </Typography>
          <List dense aria-label="What is shared">
            {(view?.sharing.shared ?? []).map((line) => (
              <ListItem key={line} sx={{ display: 'list-item', listStyleType: 'disc', ml: 2, pl: 0 }}>
                <Typography variant="body2">{line}</Typography>
              </ListItem>
            ))}
          </List>

          <Typography variant="subtitle2" component="h3" sx={{ mt: 1 }}>
            Never shared
          </Typography>
          <List dense aria-label="Never shared">
            {(view?.sharing.neverShared ?? []).map((line) => (
              <ListItem key={line} sx={{ display: 'list-item', listStyleType: 'disc', ml: 2, pl: 0 }}>
                <Typography variant="body2">{line}</Typography>
              </ListItem>
            ))}
          </List>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {HEALTH_SUMMARY_NOT_MEDICAL_ADVICE} You can turn this off at any time.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleConfirm()}>
            Turn on
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

export default HealthSummarySection;
