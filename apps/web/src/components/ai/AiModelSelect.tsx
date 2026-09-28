/**
 * Model picker over `GET /api/ai/models` — issue #434, epic #419.
 *
 * Presentational: the page loads the usable models (they also drive which
 * controls it shows and its empty state) and passes them in. Every model
 * passed is listed; one that lacks `capability` (the playground mode's
 * capability, #445 — `responses` by default) is shown DISABLED with the
 * reason, rather than hidden. The playground itself passes only the models
 * its current mode can use, so this is defence for any other caller.
 */
import { Box, ListItemText, MenuItem, TextField, Typography } from '@mui/material';
import type { UsableAiModel } from '../../services/ai';
import { AiCapabilityChips } from './AiCapabilityChips';
import { aiCapabilityLabel } from './aiCapabilities';

/** Whose key pays, as a menu line says it. `'none'` (#448) is a keyless server. */
const KEY_SOURCE_SHORT: Record<string, string> = {
  user: 'your key',
  org: 'organisation key',
  none: 'no key needed',
};

/** Whose key pays, as the caption under the selection says it. */
const KEY_SOURCE_BILLING: Record<string, string> = {
  user: 'billed to your key',
  org: 'billed to the organisation key',
  none: 'keyless server — no key is billed',
};

/** Stable key for a provider/model pair. */
export function aiModelKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}:${model.modelId}`;
}

export function aiModelLabel(model: UsableAiModel): string {
  return model.displayName || model.modelId;
}

export function hasAiCapability(model: UsableAiModel | null | undefined, capability: string): boolean {
  return model?.capabilities.capabilities.includes(capability) ?? false;
}

/** Why a model cannot be picked for `capability`, or `null` when it can. */
export function aiModelDisabledReason(model: UsableAiModel, capability = 'responses'): string | null {
  if (hasAiCapability(model, capability)) return null;
  if (capability === 'responses') return 'Does not support text responses';
  return `Does not support ${aiCapabilityLabel(capability).toLowerCase()}`;
}

export interface AiModelSelectProps {
  models: UsableAiModel[];
  /** {@link aiModelKey} of the selection, or `''`. */
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  /** The capability a model needs to be pickable. Defaults to `responses`. */
  capability?: string;
}

export function AiModelSelect({ models, value, onChange, disabled, capability = 'responses' }: AiModelSelectProps) {
  const selected = models.find((model) => aiModelKey(model) === value) ?? null;

  return (
    <Box>
      <TextField
        select
        fullWidth
        size="small"
        label="Model"
        value={selected ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        slotProps={{
          select: {
            renderValue: (key) => {
              const model = models.find((entry) => aiModelKey(entry) === key);
              return model ? aiModelLabel(model) : '';
            },
          },
        }}
      >
        {models.map((model) => {
          const reason = aiModelDisabledReason(model, capability);
          return (
            <MenuItem key={aiModelKey(model)} value={aiModelKey(model)} disabled={reason !== null}>
              <ListItemText
                primary={aiModelLabel(model)}
                secondary={
                  reason ??
                  `${model.provider} · ${KEY_SOURCE_SHORT[model.keySource] ?? 'your key'}`
                }
              />
            </MenuItem>
          );
        })}
      </TextField>
      {selected && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
            {selected.provider} · {selected.modelId} ·{' '}
            {KEY_SOURCE_BILLING[selected.keySource] ?? 'billed to your key'}
          </Typography>
          <AiCapabilityChips capabilities={selected.capabilities.capabilities} />
        </Box>
      )}
    </Box>
  );
}

export default AiModelSelect;
