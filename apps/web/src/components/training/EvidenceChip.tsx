/**
 * An evidence reference (`E1`) on a block, workout or exercise rationale. It
 * opens a popover with the claim, how it applies, the confidence and its
 * verified sources (never an unverified one: `parseEvidence` drops them).
 */
import { useId, useState } from 'react';
import { Box, Chip, Link, List, ListItem, Popover, Typography } from '@mui/material';
import type { PlanEvidence } from './planEvidence';

export interface EvidenceChipProps {
  refId: string;
  evidence: PlanEvidence;
}

const CONFIDENCE: Record<string, string> = { high: 'High confidence', moderate: 'Moderate confidence', medium: 'Moderate confidence', low: 'Low confidence' };

export function EvidenceChip({ refId, evidence }: EvidenceChipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const claim = evidence.claims.get(refId);
  if (!claim) return null;
  const sources = claim.sourceIds.map((sid) => evidence.sources.get(sid)).filter((s): s is NonNullable<typeof s> => !!s);
  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        label={refId}
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={anchor ? 'true' : 'false'}
        aria-label={`Evidence ${refId}`}
        sx={{ height: 22 }}
        data-testid={`evidence-chip-${refId}`}
      />
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-labelledby': `${id}-title`, sx: { p: 2, maxWidth: 360 } } as object }}
      >
        <Typography id={`${id}-title`} variant="subtitle2">
          Evidence {refId}
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {claim.claim}
        </Typography>
        {claim.applicability && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {claim.applicability}
          </Typography>
        )}
        <Typography variant="caption" component="p" sx={{ mt: 0.5 }}>
          {CONFIDENCE[claim.confidence] ?? claim.confidence}
        </Typography>
        {sources.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <List dense disablePadding aria-label={`Sources for ${refId}`}>
              {sources.map((source) => (
                <ListItem key={source.id} disableGutters sx={{ py: 0.25 }}>
                  <Link href={source.url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {source.title || source.domain}
                  </Link>
                </ListItem>
              ))}
            </List>
          </Box>
        )}
      </Popover>
    </>
  );
}

export default EvidenceChip;
