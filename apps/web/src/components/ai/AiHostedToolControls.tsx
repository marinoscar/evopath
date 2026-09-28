/**
 * The chat's provider-hosted tool toggles — issue #445 (API #442).
 *
 * A tool is offered only when BOTH gates the API enforces are open: the
 * selected model declares `hosted_tools`, and an administrator has switched
 * that tool type on (`GET /ai/config` → `hostedTools`). Anything else would
 * be refused (`AI_CAPABILITY_UNSUPPORTED` / `403 AI_TOOL_DISABLED`).
 *
 * The playground offers four of the five types:
 *
 * - `web_search`, with an optional search context size;
 * - `file_search`, with a free-text list of provider-side vector store ids
 *   (the API requires at least one; the playground has no vector-store
 *   browser, so the user pastes ids they created with the provider);
 * - `code_interpreter` (the provider-managed `auto` container);
 * - `image_generation` (images are saved as the user's storage objects).
 *
 * `mcp` is deliberately NOT offered here: a useful MCP call needs a server
 * URL plus, usually, an `Authorization` header — a secret this reference UI
 * should not invite users to paste into a playground (and one a background
 * run refuses outright). A fork that needs it sends an `mcp` tool from its
 * own feature code.
 */
import { useId } from 'react';
import { FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import type { AiHostedTool, AiHostedToolType, UsableAiModel } from '../../services/ai';
import { hasAiCapability } from './AiModelSelect';

/** The hosted tool types this playground can configure, in display order. */
export const PLAYGROUND_HOSTED_TOOLS = ['web_search', 'file_search', 'code_interpreter', 'image_generation'] as const;
export type PlaygroundHostedToolType = (typeof PLAYGROUND_HOSTED_TOOLS)[number];

const LABELS: Record<PlaygroundHostedToolType, string> = {
  web_search: 'Web search',
  file_search: 'File search',
  code_interpreter: 'Code interpreter',
  image_generation: 'Image generation',
};

export interface HostedToolSelection {
  on: Partial<Record<PlaygroundHostedToolType, boolean>>;
  /** `''` = the provider's default. */
  searchContextSize: '' | 'low' | 'medium' | 'high';
  /** Comma- or whitespace-separated vector store ids for `file_search`. */
  vectorStoreIds: string;
}

export const INITIAL_HOSTED_TOOL_SELECTION: HostedToolSelection = {
  on: {},
  searchContextSize: '',
  vectorStoreIds: '',
};

/** The tool types offered for `model` under the deployment's `hostedTools` switches. */
export function offeredHostedTools(
  model: UsableAiModel | null | undefined,
  enabled: Partial<Record<AiHostedToolType, boolean>> | undefined,
): PlaygroundHostedToolType[] {
  if (!hasAiCapability(model, 'hosted_tools') || !enabled) return [];
  return PLAYGROUND_HOSTED_TOOLS.filter((type) => enabled[type] === true);
}

export function parseVectorStoreIds(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * The `tools` array for the switched-on, offered tools — or an `error` that
 * blocks sending (file search with no vector store id). A tool switched on
 * but no longer offered (the model changed) is simply left out.
 */
export function buildHostedTools(
  selection: HostedToolSelection,
  offered: readonly PlaygroundHostedToolType[],
): { tools: AiHostedTool[]; error: string | null } {
  const tools: AiHostedTool[] = [];
  let error: string | null = null;
  for (const type of offered) {
    if (!selection.on[type]) continue;
    switch (type) {
      case 'web_search':
        tools.push(
          selection.searchContextSize
            ? { type, searchContextSize: selection.searchContextSize }
            : { type },
        );
        break;
      case 'file_search': {
        const ids = parseVectorStoreIds(selection.vectorStoreIds);
        if (ids.length === 0) error = 'Enter at least one vector store ID for file search';
        else if (ids.length > 16) error = 'At most 16 vector store IDs';
        else tools.push({ type, vectorStoreIds: ids });
        break;
      }
      case 'code_interpreter':
      case 'image_generation':
        tools.push({ type });
        break;
    }
  }
  return { tools, error };
}

export interface AiHostedToolControlsProps {
  offered: readonly PlaygroundHostedToolType[];
  value: HostedToolSelection;
  onChange: (next: HostedToolSelection) => void;
  error: string | null;
}

export function AiHostedToolControls({ offered, value, onChange, error }: AiHostedToolControlsProps) {
  const headingId = useId();
  if (offered.length === 0) return null;
  const toggle = (type: PlaygroundHostedToolType, on: boolean) => onChange({ ...value, on: { ...value.on, [type]: on } });

  return (
    <Stack spacing={1} role="group" aria-labelledby={headingId}>
      <Typography id={headingId} variant="subtitle2" component="h2">
        Hosted tools
      </Typography>
      {offered.map((type) => (
        <Stack key={type} spacing={1}>
          <FormControlLabel
            control={<Switch checked={!!value.on[type]} onChange={(event) => toggle(type, event.target.checked)} />}
            label={LABELS[type]}
          />
          {type === 'web_search' && value.on.web_search && (
            <TextField
              select
              size="small"
              label="Search context size"
              value={value.searchContextSize}
              onChange={(event) =>
                onChange({ ...value, searchContextSize: event.target.value as HostedToolSelection['searchContextSize'] })
              }
            >
              <MenuItem value="">Provider default</MenuItem>
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </TextField>
          )}
          {type === 'file_search' && value.on.file_search && (
            <TextField
              size="small"
              label="Vector store IDs"
              placeholder="vs_abc123, vs_def456"
              value={value.vectorStoreIds}
              onChange={(event) => onChange({ ...value, vectorStoreIds: event.target.value })}
              error={error !== null}
              helperText={error ?? 'Vector stores you created with the provider, comma-separated'}
            />
          )}
        </Stack>
      ))}
    </Stack>
  );
}

export default AiHostedToolControls;
