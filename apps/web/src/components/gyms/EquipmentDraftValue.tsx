/**
 * The read view of one `gym_equipment` draft item (E3.4), the `renderValue`
 * the scan page hands to `AiDraftReview`: the name, "×quantity" with a
 * "count uncertain" chip when the AI was not sure of the count, the brand
 * (with the AI's evidence for it as a tooltip and as text for screen
 * readers), the model and configuration, the capabilities and target
 * muscles, and the user's notes.
 *
 * Uncertainty is shown, never hidden: a brand the AI inferred keeps its
 * evidence next to it.
 */
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import { humanizeSlug, type EquipmentValue } from '../../services/gymScan';

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export interface EquipmentDraftValueProps {
  value: EquipmentValue;
  /** A one-line summary without chips (used for "AI said: …"). */
  compact?: boolean;
}

/** "Elliptical ×3, Precor EFX" — a plain-text summary of a value. */
export function equipmentValueSummary(value: Pick<EquipmentValue, 'name' | 'quantity' | 'brand' | 'model' | 'configuration'>): string {
  const head = `${value.name || 'Unnamed equipment'} ×${value.quantity}`;
  const detail = [value.brand, value.model].filter(Boolean).join(' ');
  return [head, detail, value.configuration].filter(Boolean).join(', ');
}

export function EquipmentDraftValue({ value, compact = false }: EquipmentDraftValueProps) {
  if (compact) return <span>{equipmentValueSummary(value)}</span>;

  const muscles = value.targetMuscles.filter(Boolean);
  return (
    <Box data-testid="equipment-draft-value">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.5 }}>
        <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          {value.name || 'Unnamed equipment'}
        </Typography>
        <Typography component="span" color="text.secondary" data-testid="equipment-draft-quantity">
          <Box component="span" sx={visuallyHidden}>
            quantity{' '}
          </Box>
          ×{value.quantity}
        </Typography>
        {value.quantityUncertain && <Chip size="small" color="warning" variant="outlined" label="count uncertain" />}
        {value.equipmentTypeSlug === null && value.name !== '' && (
          <Chip size="small" variant="outlined" label="Not in the catalog" />
        )}
      </Box>

      {(value.brand || value.model) && (
        <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          {value.brand &&
            (value.brandEvidence ? (
              <Tooltip title={value.brandEvidence} describeChild>
                <Box
                  component="span"
                  tabIndex={0}
                  data-testid="equipment-draft-brand"
                  sx={{ textDecoration: 'underline dotted', textUnderlineOffset: 3, cursor: 'help' }}
                >
                  {value.brand}
                  <Box component="span" sx={visuallyHidden}>
                    {` (evidence: ${value.brandEvidence})`}
                  </Box>
                </Box>
              </Tooltip>
            ) : (
              <span data-testid="equipment-draft-brand">{value.brand}</span>
            ))}
          {value.brand && value.model ? ' ' : null}
          {value.model}
        </Typography>
      )}

      {value.configuration && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {value.configuration}
        </Typography>
      )}

      {value.capabilitySlugs.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75 }} role="group" aria-label="Capabilities">
          {value.capabilitySlugs.map((slug) => (
            <Chip key={slug} size="small" label={humanizeSlug(slug)} />
          ))}
        </Stack>
      )}

      {muscles.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          Targets {muscles.map((m) => humanizeSlug(m).toLowerCase()).join(', ')}
        </Typography>
      )}

      {value.notes && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {value.notes}
        </Typography>
      )}
    </Box>
  );
}

export default EquipmentDraftValue;
