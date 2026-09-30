/**
 * Shared pieces for change log entries (E5.8): the status chip, the operation
 * lines (the server-authored `description` of each stored operation) and the
 * cited sources. Presentation only; the API wrote every string shown here
 * except the fixed labels.
 */
import { Box, Chip, Link, List, ListItem, Typography, type ChipProps } from '@mui/material';
import type { ChangeLogEntry, ChangeStatus, StoredOperation } from '../../services/programs';
import { CHANGE_STATUS_LABEL } from './planLabels';

export const CHANGE_STATUS_COLOR: Record<ChangeStatus, ChipProps['color']> = {
  applied: 'success',
  proposed: 'info',
  rejected: 'default',
  reverted: 'warning',
  superseded: 'default',
  expired: 'default',
};

/** The chip for an entry: `Reviewed` for a review (it has no status of its own to decide), else its status. */
export function ChangeStatusChip({ entry }: { entry: ChangeLogEntry }) {
  if (entry.kind === 'reviewed') return <Chip size="small" variant="outlined" label="Reviewed" data-testid="change-status" />;
  return (
    <Chip
      size="small"
      variant={entry.status === 'applied' ? 'outlined' : 'filled'}
      color={CHANGE_STATUS_COLOR[entry.status] ?? 'default'}
      label={CHANGE_STATUS_LABEL[entry.status] ?? entry.status}
      data-testid="change-status"
    />
  );
}

/** The readable line of one stored operation, or null for a shape without one. */
export function operationLine(op: StoredOperation): string | null {
  return typeof op.description === 'string' && op.description.trim() ? op.description : null;
}

export function OperationLines({ operations, label = 'Changes' }: { operations: StoredOperation[]; label?: string }) {
  const lines = operations
    .map((op) => ({ text: operationLine(op), forced: op.forced === true }))
    .filter((l): l is { text: string; forced: boolean } => l.text !== null);
  if (lines.length === 0) return null;
  return (
    <Box component="ul" aria-label={label} sx={{ pl: 2.5, my: 0.5 }}>
      {lines.map((line, i) => (
        <Typography key={i} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }} data-testid="operation-line">
          {line.text}
          {line.forced && (
            <Typography component="span" variant="body2" color="text.secondary">
              {' '}
              (safety)
            </Typography>
          )}
        </Typography>
      ))}
    </Box>
  );
}

interface Citation {
  url: string;
  title: string;
  publisher: string;
  year: number | null;
}

function citationsOf(citations: Record<string, unknown>[]): Citation[] {
  return citations
    .map((c) => ({
      url: typeof c.url === 'string' ? c.url : '',
      title: typeof c.title === 'string' ? c.title : '',
      publisher: typeof c.publisher === 'string' ? c.publisher : '',
      year: typeof c.year === 'number' ? c.year : null,
    }))
    .filter((c) => /^https?:\/\//.test(c.url));
}

export function CitationLinks({ citations }: { citations: Record<string, unknown>[] }) {
  const list = citationsOf(citations);
  if (list.length === 0) return null;
  return (
    <List dense disablePadding aria-label="Sources for this change">
      {list.map((c) => (
        <ListItem key={c.url} disableGutters sx={{ display: 'block', py: 0.25 }}>
          <Link href={c.url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {c.title || c.url}
          </Link>
          {(c.publisher || c.year) && (
            <Typography component="span" variant="body2" color="text.secondary">
              {' '}
              · {[c.publisher, c.year].filter(Boolean).join(', ')}
            </Typography>
          )}
        </ListItem>
      ))}
    </List>
  );
}
