/**
 * The change log: who changed the plan (the AI or you), what kind of change,
 * the summary, when, and its status. `renderStatus` and `renderActions` are
 * the slots later screens use (an undo, a proposal decision).
 */
import type { ReactNode } from 'react';
import { Box, Chip, List, ListItem, Stack, Typography } from '@mui/material';
import { AutoAwesome as AiIcon, Person as PersonIcon } from '@mui/icons-material';
import type { ChangeLogEntry } from '../../services/programs';
import { formatRelativeTime } from '../../utils/relativeTime';
import { CHANGE_KIND_LABEL, CHANGE_STATUS_LABEL } from './planLabels';

export interface ChangeLogListProps {
  entries: ChangeLogEntry[];
  renderStatus?: (entry: ChangeLogEntry) => ReactNode;
  renderActions?: (entry: ChangeLogEntry) => ReactNode;
}

export function ChangeLogList({ entries, renderStatus, renderActions }: ChangeLogListProps) {
  if (entries.length === 0) return <Typography color="text.secondary">No changes yet.</Typography>;
  return (
    <List dense disablePadding aria-label="Change log">
      {entries.map((entry) => (
        <ListItem key={entry.id} disableGutters sx={{ display: 'block', py: 1, borderTop: 1, borderColor: 'divider' }} data-testid="change-log-entry">
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip
              size="small"
              variant="outlined"
              icon={entry.actor === 'ai' ? <AiIcon /> : <PersonIcon />}
              label={entry.actor === 'ai' ? 'AI' : 'You'}
            />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {CHANGE_KIND_LABEL[entry.kind] ?? entry.kind}
            </Typography>
            {renderStatus ? renderStatus(entry) : <Chip size="small" label={CHANGE_STATUS_LABEL[entry.status] ?? entry.status} />}
            <Typography variant="body2" color="text.secondary">
              {formatRelativeTime(entry.createdAt)}
              {entry.toVersion ? ` · version ${entry.toVersion}` : ''}
            </Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {entry.summary}
          </Typography>
          {renderActions && <Box sx={{ mt: 0.5 }}>{renderActions(entry)}</Box>}
        </ListItem>
      ))}
    </List>
  );
}

export default ChangeLogList;
