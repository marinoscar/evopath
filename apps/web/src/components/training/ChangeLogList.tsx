/**
 * The change log: who changed the plan (the AI, you, or a safety check), what
 * kind of change, the summary, when, and its status (Applied, Proposed,
 * Rejected, Undone, Superseded, Expired, or Reviewed for a review that
 * changed nothing). Each entry lists its operations as readable lines and its
 * sources; an undone entry and the entry that undid another are marked.
 * `renderStatus` and `renderActions` are the slots for an undo or a
 * proposal decision.
 */
import type { ReactElement, ReactNode } from 'react';
import { Box, Chip, List, ListItem, Stack, Typography } from '@mui/material';
import {
  AutoAwesome as AiIcon,
  HealthAndSafety as SafetyIcon,
  Person as PersonIcon,
  Undo as UndoIcon,
} from '@mui/icons-material';
import type { ChangeActor, ChangeLogEntry } from '../../services/programs';
import { formatRelativeTime } from '../../utils/relativeTime';
import { CHANGE_KIND_LABEL } from './planLabels';
import { ChangeStatusChip, CitationLinks, OperationLines } from './changeLogParts';

export interface ChangeLogListProps {
  entries: ChangeLogEntry[];
  renderStatus?: (entry: ChangeLogEntry) => ReactNode;
  renderActions?: (entry: ChangeLogEntry) => ReactNode;
}

const ACTOR: Record<ChangeActor, { label: string; icon: ReactElement }> = {
  ai: { label: 'AI', icon: <AiIcon /> },
  user: { label: 'You', icon: <PersonIcon /> },
  system: { label: 'Safety', icon: <SafetyIcon /> },
};

export function ChangeLogList({ entries, renderStatus, renderActions }: ChangeLogListProps) {
  if (entries.length === 0) return <Typography color="text.secondary">No changes yet.</Typography>;
  const summaryOf = new Map(entries.map((e) => [e.id, e.summary]));
  return (
    <List dense disablePadding aria-label="Change log">
      {entries.map((entry) => {
        const actor = ACTOR[entry.actor] ?? ACTOR.user;
        const undoneBy = entries.find((e) => e.revertsLogId === entry.id);
        return (
          <ListItem
            key={entry.id}
            disableGutters
            sx={{ display: 'block', py: 1, borderTop: 1, borderColor: 'divider' }}
            data-testid="change-log-entry"
          >
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip size="small" variant="outlined" icon={actor.icon} label={actor.label} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {CHANGE_KIND_LABEL[entry.kind] ?? entry.kind}
              </Typography>
              {renderStatus ? renderStatus(entry) : <ChangeStatusChip entry={entry} />}
              <Typography variant="body2" color="text.secondary">
                {formatRelativeTime(entry.createdAt)}
                {entry.toVersion && entry.kind !== 'reviewed' ? ` · version ${entry.toVersion}` : ''}
              </Typography>
            </Stack>
            <Typography
              variant="body2"
              sx={{
                mt: 0.5,
                overflowWrap: 'anywhere',
                ...(entry.status === 'reverted' ? { textDecoration: 'line-through', color: 'text.secondary' } : {}),
              }}
            >
              {entry.summary}
            </Typography>
            {entry.rationale && entry.kind !== 'created' && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, overflowWrap: 'anywhere' }}>
                {entry.rationale}
              </Typography>
            )}
            <OperationLines operations={entry.operations} label="What changed" />
            <CitationLinks citations={entry.citations} />
            {entry.status === 'reverted' && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                data-testid="reverted-marker"
              >
                <UndoIcon fontSize="inherit" aria-hidden />
                {undoneBy ? `Undone ${formatRelativeTime(undoneBy.createdAt)}` : 'Undone'}
              </Typography>
            )}
            {entry.revertsLogId && (
              <Typography variant="body2" color="text.secondary" data-testid="reverts-marker" sx={{ overflowWrap: 'anywhere' }}>
                Undid: {summaryOf.get(entry.revertsLogId) ?? 'an earlier change'}
              </Typography>
            )}
            {renderActions && <Box sx={{ mt: 0.5 }}>{renderActions(entry)}</Box>}
          </ListItem>
        );
      })}
    </List>
  );
}

export default ChangeLogList;
