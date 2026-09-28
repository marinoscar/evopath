/**
 * The parsed result of a structured-output request — issue #434, epic #419.
 *
 * Pretty-prints `AiResponse.parsed` — the value the API already validated
 * against the requested JSON Schema (a failure there is
 * `AI_STRUCTURED_OUTPUT_INVALID`, never a half-parsed object here). The block
 * scrolls horizontally on its own so a long line never widens the page.
 */
import { Box, Typography } from '@mui/material';

export interface AiStructuredOutputPanelProps {
  parsed: unknown;
  title?: string;
}

export function AiStructuredOutputPanel({ parsed, title = 'Structured output' }: AiStructuredOutputPanelProps) {
  return (
    <Box sx={{ mt: 1, minWidth: 0 }} data-testid="structured-output-panel">
      <Typography variant="overline" color="text.secondary" component="p">
        {title}
      </Typography>
      <Box
        component="pre"
        aria-label={title}
        sx={{
          m: 0,
          p: 1.5,
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          overflowX: 'auto',
          maxWidth: '100%',
        }}
      >
        {JSON.stringify(parsed, null, 2)}
      </Box>
    </Box>
  );
}

export default AiStructuredOutputPanel;
