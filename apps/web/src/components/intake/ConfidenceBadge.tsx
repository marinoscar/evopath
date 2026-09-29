/**
 * How sure the AI was about one draft item — always a TEXT label (High /
 * Medium / Low), never colour alone. Low is visually prominent (filled
 * warning chip with an icon) so it cannot be skimmed past.
 */
import { Chip } from '@mui/material';
import { ReportProblemOutlined as LowIcon } from '@mui/icons-material';
import type { DraftItemConfidence } from '../../services/intake';

const LABEL: Record<DraftItemConfidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export interface ConfidenceBadgeProps {
  confidence: DraftItemConfidence | null;
}

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  if (!confidence) return null;
  const label = `${LABEL[confidence]} confidence`;
  if (confidence === 'low') {
    return (
      <Chip
        size="small"
        color="warning"
        variant="filled"
        icon={<LowIcon />}
        label={label}
        data-confidence="low"
        sx={{ fontWeight: 600 }}
      />
    );
  }
  return (
    <Chip
      size="small"
      variant="outlined"
      color={confidence === 'high' ? 'success' : 'default'}
      label={label}
      data-confidence={confidence}
    />
  );
}

export default ConfidenceBadge;
