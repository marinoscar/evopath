/**
 * Admin → AI Models: the DataTable column contract — issue #429, epic #419.
 *
 * `GET /api/admin/ai/models` filters by `provider`, `capability`, `enabled`,
 * `includeDeprecated` and `q`, and paginates like `GET /api/admin/jobs`. It
 * does not sort, so no column here is `sortable`: a live-looking sort control
 * the endpoint cannot answer would be a lie. The page drives the filters from
 * its own toolbar; `model` is `searchable` because `q` searches it.
 *
 * THE ENABLED SWITCH IS A CELL, NOT A ROW ACTION. It is the one thing an admin
 * does to most rows, and its state is information in its own right. It is
 * DISABLED (never hidden) with a tooltip saying why when the row cannot be
 * enabled: unclassified ("Classify this model first"), withdrawn by the
 * provider, or no `ai_config:write`.
 */

import type { ReactNode } from 'react';
import { Box, Chip, Stack, Switch, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../datatable';
import type { AiModel } from '../../../services/ai';
import { AiCapabilityChips } from '../../ai/AiCapabilityChips';
import { capabilitySummary } from '../../ai/aiCapabilities';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'ai-models';

export const CAPABILITY_SOURCE_LABELS: Record<AiModel['capabilitySource'], string> = {
  catalog: 'catalog',
  admin_override: 'admin override',
  unclassified: 'unclassified',
};

export function isDeprecated(model: AiModel): boolean {
  return model.deprecatedAt !== null;
}

export function isUnclassified(model: AiModel): boolean {
  return model.capabilitySource === 'unclassified';
}

/** Why the Enabled switch is disabled for this row, or `null` when it is live. */
export function enableBlockedReason(model: AiModel, canWrite: boolean): string | null {
  if (!canWrite) return 'Changing a model needs ai_config:write';
  if (isDeprecated(model)) return 'Withdrawn by provider — it can no longer be enabled';
  if (isUnclassified(model) && !model.enabled) return 'Classify this model first';
  return null;
}

/** A withdrawn model reads as greyed out in every cell. */
function Dimmed({ model, children }: { model: AiModel; children: ReactNode }) {
  return <Box sx={{ opacity: isDeprecated(model) ? 0.6 : 1, minWidth: 0 }}>{children}</Box>;
}

export interface AiModelColumnOptions {
  canWrite: boolean;
  pendingIds: ReadonlySet<string>;
  onToggleEnabled: (model: AiModel, enabled: boolean) => void;
}

export function buildAiModelColumns({
  canWrite,
  pendingIds,
  onToggleEnabled,
}: AiModelColumnOptions): DataTableColumn<AiModel>[] {
  return [
    {
      // Row-unique within a provider, and so the row's accessible name.
      id: 'model',
      label: 'Model',
      priority: 'primary',
      searchable: true,
      hideable: false,
      minWidth: 220,
      flex: 1.4,
      value: (model) => model.modelId,
      render: (model) => (
        <Dimmed model={model}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }} noWrap>
            {model.modelId}
          </Typography>
          {model.displayName && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {model.displayName}
            </Typography>
          )}
        </Dimmed>
      ),
    },
    {
      id: 'capabilities',
      label: 'Capabilities',
      priority: 'secondary',
      minWidth: 240,
      flex: 1.6,
      value: (model) => capabilitySummary(model.capabilities?.capabilities ?? []),
      render: (model) => (
        <Dimmed model={model}>
          <AiCapabilityChips
            grouped
            capabilities={model.capabilities?.capabilities ?? []}
            emptyLabel="None"
          />
        </Dimmed>
      ),
    },
    {
      id: 'source',
      label: 'Source',
      priority: 'primary',
      width: 190,
      value: (model) =>
        isDeprecated(model)
          ? `${CAPABILITY_SOURCE_LABELS[model.capabilitySource]}, withdrawn by provider`
          : CAPABILITY_SOURCE_LABELS[model.capabilitySource],
      render: (model) => (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
          <Chip
            size="small"
            label={CAPABILITY_SOURCE_LABELS[model.capabilitySource]}
            color={
              isUnclassified(model)
                ? 'warning'
                : model.capabilitySource === 'admin_override'
                  ? 'info'
                  : 'default'
            }
            variant={isUnclassified(model) ? 'filled' : 'outlined'}
          />
          {isDeprecated(model) && (
            <Chip size="small" label="Withdrawn by provider" variant="outlined" />
          )}
        </Stack>
      ),
    },
    {
      id: 'provider',
      label: 'Provider',
      priority: 'detail',
      width: 120,
      value: (model) => model.provider,
    },
    {
      id: 'lastSeenAt',
      label: 'Last seen',
      priority: 'secondary',
      minWidth: 170,
      value: (model) => new Date(model.lastSeenAt).toLocaleString(),
    },
    {
      id: 'enabled',
      label: 'Enabled',
      priority: 'primary',
      width: 110,
      value: (model) => (model.enabled ? 'Yes' : 'No'),
      render: (model) => {
        const blocked = enableBlockedReason(model, canWrite);
        const control = (
          <Switch
            checked={model.enabled}
            disabled={!!blocked || pendingIds.has(model.id)}
            onChange={(e) => onToggleEnabled(model, e.target.checked)}
            slotProps={{ input: { 'aria-label': `Enable ${model.modelId}` } }}
          />
        );
        return blocked ? (
          <Tooltip title={blocked}>
            {/* A disabled control fires no events; the span carries the tooltip. */}
            <span>{control}</span>
          </Tooltip>
        ) : (
          control
        );
      },
    },
  ];
}
