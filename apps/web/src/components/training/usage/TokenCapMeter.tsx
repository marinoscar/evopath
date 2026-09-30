/**
 * The per-run token cap as a meter (E6.3): used against the limit, as a
 * labelled progress bar AND a sentence, so the state never rests on colour
 * alone. "Limit reached" is said in words when the run stopped at it.
 */
import { useId } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';
import { formatCount } from '../../ai/usage';
import type { TrainingRunCap } from '../../../services/trainingUsage';

export interface TokenCapMeterProps {
  cap: Pick<TrainingRunCap, 'usedTokens' | 'reached'> & { limitTokens: number | null };
}

/** `12,340 of 120,000 tokens used (10%)`, plus ", limit reached" when it was. */
export function tokenCapSentence(cap: TokenCapMeterProps['cap']): string | null {
  if (cap.limitTokens === null || cap.limitTokens <= 0) return null;
  const percent = Math.round((cap.usedTokens / cap.limitTokens) * 100);
  const base = `${formatCount(cap.usedTokens)} of ${formatCount(cap.limitTokens)} tokens used (${percent}%)`;
  return cap.reached ? `${base}, limit reached` : base;
}

export function TokenCapMeter({ cap }: TokenCapMeterProps) {
  const labelId = useId();
  const sentence = tokenCapSentence(cap);
  if (sentence === null || cap.limitTokens === null) return null;
  const value = Math.min(100, Math.max(0, (cap.usedTokens / cap.limitTokens) * 100));
  return (
    <Box data-testid="token-cap-meter">
      <Typography id={labelId} variant="body2" sx={{ fontWeight: 600 }}>
        Your token limit per run
      </Typography>
      <LinearProgress
        variant="determinate"
        value={value}
        color={cap.reached ? 'warning' : 'primary'}
        aria-labelledby={labelId}
        aria-valuetext={sentence}
        sx={{ height: 8, borderRadius: 4, my: 0.75 }}
      />
      <Typography variant="body2" color="text.secondary" data-testid="token-cap-text">
        {sentence}
      </Typography>
    </Box>
  );
}

export default TokenCapMeter;
