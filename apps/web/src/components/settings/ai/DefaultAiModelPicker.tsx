/**
 * The user's default AI model — issue #430, epic #419.
 *
 * Stored in the user settings DOCUMENT as `ai.defaultModel: { provider,
 * modelId } | null` (see `docs/specs/ai-platform.md` §2.1), through the existing
 * `useUserSettings` hook's PATCH — not a new endpoint. Only models with the
 * `responses` capability are offered, since a default is what a plain
 * request (the Playground, a fork's feature) falls back to.
 *
 * A saved default that is no longer usable (the admin disabled it, the key
 * lost access, the key was removed) is kept and surfaced as a warning rather
 * than silently cleared: the user decides what replaces it.
 */
import { useState } from 'react';
import {
  Alert,
  Card,
  CardContent,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import type { UsableAiModel } from '../../../services/ai';
import type { AiDefaultModel } from '../../../types';

export interface DefaultAiModelPickerProps {
  models: UsableAiModel[];
  /** The saved default, or null/undefined when none has been chosen. */
  value: AiDefaultModel | null | undefined;
  /** Persist a new default (null clears it). Rejects on failure. */
  onChange: (next: AiDefaultModel | null) => Promise<void>;
  disabled?: boolean;
  providerNames: Record<string, string>;
}

const NONE = '';
const SEP = '\u0000';

const toValue = (model: AiDefaultModel) => `${model.provider}${SEP}${model.modelId}`;

export function DefaultAiModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  providerNames,
}: DefaultAiModelPickerProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const options = models.filter((model) => model.capabilities.capabilities.includes('responses'));
  const current = value ?? null;
  const currentAvailable =
    current !== null &&
    options.some((model) => model.provider === current.provider && model.modelId === current.modelId);
  // Not while the list is still loading: an empty list is not evidence.
  const missing = !disabled && current !== null && !currentAvailable;

  const handleChange = async (raw: string) => {
    setError(null);
    setSaved(false);
    const next =
      raw === NONE
        ? null
        : (() => {
            const [provider, modelId] = raw.split(SEP);
            return { provider, modelId };
          })();
    setSaving(true);
    try {
      await onChange(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save your default model');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card component="section" aria-labelledby="default-ai-model-title">
      <CardContent>
        <Typography id="default-ai-model-title" variant="h6" component="h2" gutterBottom>
          Default model
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Used when a request does not name a model.
        </Typography>

        {missing && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Your default model is no longer available ({current?.modelId}). Choose another one.
          </Alert>
        )}

        <FormControl fullWidth disabled={disabled || saving}>
          <InputLabel id="default-ai-model-label">Default model</InputLabel>
          <Select
            labelId="default-ai-model-label"
            label="Default model"
            value={current && currentAvailable ? toValue(current) : NONE}
            onChange={(e) => void handleChange(String(e.target.value))}
          >
            <MenuItem value={NONE}>
              <em>No default</em>
            </MenuItem>
            {options.map((model) => (
              <MenuItem key={toValue(model)} value={toValue(model)}>
                {providerNames[model.provider] ?? model.provider} ·{' '}
                {model.displayName ?? model.modelId}
              </MenuItem>
            ))}
          </Select>
          {options.length === 0 && (
            <FormHelperText>No usable model supports text responses yet.</FormHelperText>
          )}
        </FormControl>

        {saved && (
          <Alert severity="success" sx={{ mt: 2 }}>
            Default model saved.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
