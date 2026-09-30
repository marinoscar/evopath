/**
 * One training agent role: what it does, which model and reasoning effort it
 * uses, and its state.
 *
 * The choice is stored in the user settings document as
 * `ai.taskModels.<role>` (`{ provider, modelId, reasoningEffort }`, `null`
 * clears it back to the automatic choice); the page does the PATCH. Models
 * that lack a capability the role needs stay listed but disabled with the
 * reason. The researcher also needs an OpenAI model, since hosted web search
 * is driven through that provider only. The API re-checks all of it when a run
 * starts; this card only guides the choice.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { AiModelSelect, aiModelKey } from '../ai/AiModelSelect';
import type { UsableAiModel } from '../../services/ai';
import type { RoleResolution } from '../../services/trainingAgents';
import type { AiTaskModel, TaskReasoningEffort, TrainingAgentRole } from '../../types';
import { RoleStateBanner } from './RoleStateBanner';

export const TRAINING_ROLE_COPY: Record<TrainingAgentRole, { title: string; job: string }> = {
  researcher: {
    title: 'Researcher',
    job: 'Searches the web for current evidence that bears on your goals.',
  },
  planner: {
    title: 'Planner',
    job: 'Drafts your training plan from your goals, history and the research.',
  },
  critic: {
    title: 'Critic',
    job: 'Reviews each draft for safety and fit and asks for revisions.',
  },
  evaluator: {
    title: 'Evaluator',
    job: 'Checks how the plan is going against your logged training.',
  },
};

/** Fallback needs per role, used only until the API has answered. */
const ROLE_NEEDS: Record<TrainingAgentRole, string[]> = {
  researcher: ['responses', 'structured_output', 'hosted_tools'],
  planner: ['responses', 'structured_output'],
  critic: ['responses', 'structured_output'],
  evaluator: ['responses', 'structured_output'],
};

const RESEARCHER_PROVIDERS = ['openai'];

/** Whose key a request is sent with, as the "where data goes" line says it. */
const DATA_KEY_PHRASE: Record<string, string> = {
  user: 'your key',
  org: 'the organisation key',
  none: 'no key (keyless server)',
};

const TASK_EFFORTS: readonly TaskReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

const ROLE_DEFAULT = '';

/** The efforts a model offers, in order; empty when it has no adjustable reasoning. */
export function offeredEfforts(model: UsableAiModel | null | undefined): TaskReasoningEffort[] {
  if (!model || !model.capabilities.capabilities.includes('reasoning')) return [];
  const offered = model.capabilities.reasoningEfforts ?? [];
  return TASK_EFFORTS.filter((effort) => offered.includes(effort));
}

export interface AgentModelCardProps {
  role: TrainingAgentRole;
  resolution: RoleResolution | undefined;
  models: UsableAiModel[];
  /** The saved choice for this role, if any. */
  value: AiTaskModel | undefined;
  /** Persist a new choice (`null` clears it). Rejects on failure. */
  onSave: (next: AiTaskModel | null) => Promise<void>;
  providerNames: Record<string, string>;
  disabled?: boolean;
}

export function AgentModelCard({
  role,
  resolution,
  models,
  value,
  onSave,
  providerNames,
  disabled = false,
}: AgentModelCardProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = TRAINING_ROLE_COPY[role];
  const titleId = `agent-${role}-title`;
  const effortLabelId = `agent-${role}-effort-label`;
  const needs = resolution?.needs ?? ROLE_NEEDS[role];

  const savedKey = value ? aiModelKey(value) : '';
  const savedModel = value ? models.find((model) => aiModelKey(model) === savedKey) ?? null : null;
  const efforts = offeredEfforts(savedModel);
  const savedEffort = value?.reasoningEffort ?? null;

  const save = async (next: AiTaskModel | null) => {
    setError(null);
    setSaving(true);
    try {
      await onSave(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save this agent');
    } finally {
      setSaving(false);
    }
  };

  const handleModelChange = (key: string) => {
    const model = models.find((entry) => aiModelKey(entry) === key);
    if (!model) return;
    // Keep the chosen effort only when the new model offers it.
    const keep = savedEffort !== null && offeredEfforts(model).includes(savedEffort) ? savedEffort : null;
    void save({ provider: model.provider, modelId: model.modelId, reasoningEffort: keep });
  };

  const handleEffortChange = (raw: string) => {
    if (!value) return;
    const reasoningEffort = raw === ROLE_DEFAULT ? null : (raw as TaskReasoningEffort);
    void save({ provider: value.provider, modelId: value.modelId, reasoningEffort });
  };

  const researcherRule =
    role === 'researcher'
      ? (model: UsableAiModel) =>
          RESEARCHER_PROVIDERS.includes(model.provider) ? null : 'Web search needs an OpenAI model'
      : undefined;

  const busy = disabled || saving;
  const effortHelp = !savedModel
    ? 'Choose a model to set its reasoning effort.'
    : efforts.length === 0
      ? 'This model has no adjustable reasoning.'
      : null;

  const using = resolution?.model;

  return (
    <Card component="section" aria-labelledby={titleId}>
      <CardContent>
        <Typography id={titleId} variant="h6" component="h2" gutterBottom>
          {copy.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {copy.job}
        </Typography>

        <Stack spacing={2}>
          {resolution && <RoleStateBanner resolution={resolution} />}

          <AiModelSelect
            models={models}
            value={savedModel ? savedKey : ''}
            onChange={handleModelChange}
            capability={needs}
            disabledReason={researcherRule}
            disabled={busy}
          />

          <FormControl fullWidth size="small" disabled={busy || efforts.length === 0}>
            <InputLabel id={effortLabelId}>Reasoning effort</InputLabel>
            <Select<string>
              labelId={effortLabelId}
              label="Reasoning effort"
              value={savedEffort && efforts.includes(savedEffort) ? savedEffort : ROLE_DEFAULT}
              onChange={(event) => handleEffortChange(String(event.target.value))}
              displayEmpty
              renderValue={(selected) =>
                selected === ROLE_DEFAULT ? 'Default (role default)' : selected
              }
            >
              <MenuItem value={ROLE_DEFAULT}>Default (role default)</MenuItem>
              {efforts.map((effort) => (
                <MenuItem key={effort} value={effort}>
                  {effort}
                </MenuItem>
              ))}
            </Select>
            {effortHelp && <FormHelperText>{effortHelp}</FormHelperText>}
          </FormControl>

          {value && (
            <Box>
              <Button size="small" onClick={() => void save(null)} disabled={busy}>
                Use the automatic choice
              </Button>
            </Box>
          )}

          {using && (
            <Typography variant="body2" color="text.secondary">
              Requests for this agent go to {providerNames[using.provider] ?? using.provider} using{' '}
              {DATA_KEY_PHRASE[using.keySource] ?? 'your key'}
              .
            </Typography>
          )}

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default AgentModelCard;
