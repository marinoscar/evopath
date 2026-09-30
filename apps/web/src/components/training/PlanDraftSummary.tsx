/** Each draft round's size: weeks, workouts, exercises. */
import { List, ListItem, Typography } from '@mui/material';
import type { RunDraft } from '../../utils/reduceRunEvents';

export function PlanDraftSummary({ drafts }: { drafts: RunDraft[] }) {
  if (drafts.length === 0) return <Typography color="text.secondary">No draft yet.</Typography>;
  return (
    <List dense disablePadding aria-label="Drafts">
      {drafts.map((draft) => (
        <ListItem key={draft.round} disableGutters data-testid="draft-row">
          <Typography variant="body2">
            Draft {draft.round}: {draft.weeks} weeks, {draft.workouts} workouts, {draft.exercises} exercises
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

export default PlanDraftSummary;
