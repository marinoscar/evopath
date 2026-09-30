/**
 * "What will be sent": one accordion per agent listing the sections of
 * context the API's context builder will send it (from the estimate's
 * `sentData`), what the budget leaves out, and what is never sent.
 * Presentation only; the server builds the context.
 */
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  List,
  ListItem,
  Typography,
} from '@mui/material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import type { SentDataEntry } from '../../services/trainingAgents';
import { ROLE_LABEL } from '../../hooks/useTrainingAvailability';

export const NEVER_SENT =
  'Not sent: your name, email, date of birth, medications, lab results, notes, other gyms, photos.';

export interface SentDataPanelProps {
  entries: SentDataEntry[];
}

export function SentDataPanel({ entries }: SentDataPanelProps) {
  return (
    <Box data-testid="sent-data-panel">
      {entries.map((entry) => {
        const headingId = `sent-${entry.role}-heading`;
        return (
          <Accordion key={entry.role} disableGutters variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls={`sent-${entry.role}-content`} id={headingId}>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {ROLE_LABEL[entry.role]}
                {entry.model ? ` (${entry.model})` : ''}: {entry.sections.length} section{entry.sections.length === 1 ? '' : 's'}
              </Typography>
            </AccordionSummary>
            <AccordionDetails id={`sent-${entry.role}-content`}>
              <List dense disablePadding aria-label={`What the ${ROLE_LABEL[entry.role].toLowerCase()} is sent`}>
                {entry.sections.map((section) => (
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
              {entry.dropped.length > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Left out to fit this model: {entry.dropped.join(', ')}.
                </Typography>
              )}
              {entry.excluded.length > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Never sent to this agent: {entry.excluded.join(', ')}.
                </Typography>
              )}
            </AccordionDetails>
          </Accordion>
        );
      })}
      <Typography variant="body2" sx={{ mt: 1 }}>
        {NEVER_SENT}
      </Typography>
    </Box>
  );
}

export default SentDataPanel;
