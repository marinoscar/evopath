/** The difference between a version and the one before it, as a summary and a list. */
import { List, ListItem, Typography } from '@mui/material';
import type { PlanDiff } from '../../utils/planDiff';

export function SnapshotDiff({ diff, versionNumber }: { diff: PlanDiff; versionNumber: number }) {
  return (
    <>
      <Typography sx={{ fontWeight: 600 }} data-testid="diff-summary">
        {diff.summary}
      </Typography>
      {diff.changes.length > 0 && (
        <List dense disablePadding aria-label={`Changes in version ${versionNumber}`}>
          {diff.changes.map((change, i) => (
            <ListItem key={i} disableGutters sx={{ py: 0.25 }} data-testid="diff-change">
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {change.text}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
    </>
  );
}

export default SnapshotDiff;
