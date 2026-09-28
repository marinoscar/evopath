/**
 * A model's capabilities as a row of small chips — issues #434, #429, #430
 * (epic #419). The ONE capability-chip component: the playground's model
 * picker, the user's "Models you can use" list and the admin catalogue all
 * render through it.
 *
 * Two densities:
 *   - flat (default): one chip per capability, labelled from
 *     `AI_CAPABILITY_LABELS` — for a single model's detail.
 *   - `grouped`: one chip per family (Text / Reasoning / Tools / …) with a
 *     tooltip naming the exact members — for a table row, where fourteen
 *     chips would be unreadable.
 *
 * Chips carry TEXT, never colour alone. Unknown capability strings render as
 * themselves so a capability added server-side shows up instead of vanishing.
 */
import { Box, Chip, Tooltip, Typography } from '@mui/material';
import { aiCapabilityLabel, groupCapabilities } from './aiCapabilities';

export interface AiCapabilityChipsProps {
  capabilities: readonly string[];
  size?: 'small' | 'medium';
  /** One chip per capability family instead of per capability. */
  grouped?: boolean;
  /** Rendered when there is nothing to show; omitted, nothing is rendered. */
  emptyLabel?: string;
}

interface ChipSpec {
  key: string;
  label: string;
  tooltip?: string;
}

function chipSpecs(capabilities: readonly string[], grouped: boolean): ChipSpec[] {
  if (!grouped) {
    const labels = Array.from(new Set(capabilities.map(aiCapabilityLabel)));
    return labels.map((label) => ({ key: label, label }));
  }
  const { groups, unknown } = groupCapabilities(capabilities);
  return [
    ...groups.map(({ group, present }) => ({
      key: group.id,
      label: group.label,
      tooltip: present.map(aiCapabilityLabel).join(', '),
    })),
    ...unknown.map((capability) => ({ key: capability, label: capability })),
  ];
}

export function AiCapabilityChips({
  capabilities,
  size = 'small',
  grouped = false,
  emptyLabel,
}: AiCapabilityChipsProps) {
  const specs = chipSpecs(capabilities, grouped);
  if (specs.length === 0) {
    return emptyLabel ? (
      <Typography variant="body2" color="text.secondary">
        {emptyLabel}
      </Typography>
    ) : null;
  }
  return (
    <Box
      component="ul"
      aria-label="Capabilities"
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, listStyle: 'none', p: 0, m: 0 }}
    >
      {specs.map((spec) => {
        const chip = <Chip label={spec.label} size={size} variant="outlined" />;
        return (
          <Box component="li" key={spec.key}>
            {spec.tooltip ? <Tooltip title={spec.tooltip}>{chip}</Tooltip> : chip}
          </Box>
        );
      })}
    </Box>
  );
}

export { aiCapabilityLabel };
export default AiCapabilityChips;
