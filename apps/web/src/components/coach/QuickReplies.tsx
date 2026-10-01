/**
 * The composer's quick replies (E7.8, #248; docs/specs/ai-coach.md §2.13):
 * each is a real button that sends its text as the user's message.
 */
import { Box, Chip } from '@mui/material';
import { COACH_QUICK_REPLIES } from '../../services/coach';

export interface QuickRepliesProps {
  onSelect: (text: string) => void;
  disabled?: boolean;
  replies?: readonly string[];
}

export function QuickReplies({ onSelect, disabled = false, replies = COACH_QUICK_REPLIES }: QuickRepliesProps) {
  return (
    <Box
      role="group"
      aria-label="Quick replies"
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, minWidth: 0 }}
    >
      {replies.map((reply) => (
        <Chip
          key={reply}
          label={reply}
          variant="outlined"
          color="primary"
          clickable
          disabled={disabled}
          onClick={() => onSelect(reply)}
          // `Chip` with `onClick` renders role="button"; keep it focusable and labelled by its text.
          sx={{ maxWidth: '100%', minHeight: 36 }}
        />
      ))}
    </Box>
  );
}

export default QuickReplies;
