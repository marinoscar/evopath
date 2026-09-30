/**
 * "What will be sent": collapsible, rendered from the preview endpoint (the
 * same object the API sends to the models), refreshed when the chips change
 * (the sheet debounces the request through `useAdaptationPreview`).
 * Presentation only; the server builds the context.
 */
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  LinearProgress,
  List,
  ListItem,
  Typography,
} from '@mui/material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import type { AdaptationSentData } from '../../../services/trainingAdaptation';

export interface SentDataSummaryProps {
  sentData: AdaptationSentData | null;
  isLoading?: boolean;
  error?: string | null;
  /** Shown while nothing can be previewed yet. */
  emptyText?: string;
  defaultExpanded?: boolean;
}

export function SentDataSummary({
  sentData,
  isLoading = false,
  error = null,
  emptyText = 'Choose what to change to see what will be sent.',
  defaultExpanded = false,
}: SentDataSummaryProps) {
  return (
    <Accordion disableGutters variant="outlined" defaultExpanded={defaultExpanded} data-testid="sent-data-summary">
      <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="adapt-sent-content" id="adapt-sent-heading">
        <Typography>What will be sent</Typography>
      </AccordionSummary>
      <AccordionDetails id="adapt-sent-content" aria-busy={isLoading}>
        {isLoading && <LinearProgress aria-label="Updating what will be sent" sx={{ mb: 1 }} />}
        {error && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {!sentData ? (
          <Typography variant="body2" color="text.secondary">
            {emptyText}
          </Typography>
        ) : (
          <>
            <List dense disablePadding aria-label="Sent to the AI">
              {sentData.sections.map((section) => (
                <ListItem key={section.key} disableGutters sx={{ display: 'block' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {section.title}
                    {section.count !== undefined ? ` (${section.count})` : ''}
                  </Typography>
                  {section.items.length > 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {section.items.join(', ')}
                    </Typography>
                  )}
                </ListItem>
              ))}
            </List>
            {sentData.dropped.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Left out: {sentData.dropped.join(', ')}.
              </Typography>
            )}
            {sentData.excluded.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Never sent: {sentData.excluded.join(', ')}.
              </Typography>
            )}
          </>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

export default SentDataSummary;
