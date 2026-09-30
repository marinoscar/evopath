/**
 * "Tokens, not currency" with the reason one focus or hover away. The reason
 * is also the button's accessible description, so a screen reader hears it
 * without opening the tooltip.
 */
import { useId } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { InfoOutlined as InfoIcon } from '@mui/icons-material';
import { TOKENS_NOT_CURRENCY, TOKENS_NOT_CURRENCY_WHY } from './agentUsageLabels';

export function TokensNotCurrencyNote() {
  const whyId = useId();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} data-testid="tokens-not-currency">
      <Typography variant="body2" color="text.secondary">
        {TOKENS_NOT_CURRENCY}
      </Typography>
      <Tooltip title={TOKENS_NOT_CURRENCY_WHY}>
        <IconButton size="small" aria-label="Why tokens, not currency" aria-describedby={whyId}>
          <InfoIcon fontSize="small" aria-hidden />
        </IconButton>
      </Tooltip>
      <Box component="span" id={whyId} sx={visuallyHidden}>
        {TOKENS_NOT_CURRENCY_WHY}
      </Box>
    </Box>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export default TokensNotCurrencyNote;
