/**
 * A collapsible reasoning summary — issue #434, epic #419.
 *
 * Fed by `reasoning_summary.delta` frames as they stream, so it grows in step
 * with the answer. Only a SUMMARY of the model's reasoning is ever shown —
 * that is all a provider returns, and all the request asks for
 * (`reasoning.summary`). Starts expanded; the toggle is a real button with
 * `aria-expanded`, so it works from the keyboard and reads correctly.
 */
import { useId, useState } from 'react';
import { Box, Button, CircularProgress, Collapse, Typography } from '@mui/material';
import { ExpandLess as ExpandLessIcon, ExpandMore as ExpandMoreIcon } from '@mui/icons-material';

export interface AiReasoningPanelProps {
  text: string;
  /** True while the summary is still arriving. */
  streaming?: boolean;
  defaultExpanded?: boolean;
}

export function AiReasoningPanel({ text, streaming = false, defaultExpanded = true }: AiReasoningPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const regionId = useId();

  return (
    <Box
      sx={{ borderLeft: 3, borderColor: 'divider', pl: 1.5, mb: 1, minWidth: 0 }}
      data-testid="reasoning-panel"
    >
      <Button
        size="small"
        color="inherit"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={regionId}
        endIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        startIcon={streaming ? <CircularProgress size={12} aria-hidden /> : undefined}
        sx={{ px: 0.5, textTransform: 'none', color: 'text.secondary' }}
      >
        Reasoning summary
      </Button>
      <Collapse in={expanded} id={regionId}>
        <Typography
          variant="body2"
          color="text.secondary"
          component="div"
          data-testid="reasoning-text"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', pt: 0.5 }}
        >
          {text}
        </Typography>
      </Collapse>
    </Box>
  );
}

export default AiReasoningPanel;
