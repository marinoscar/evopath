/**
 * Today's `CoachHero` strip (E7.8, #248; docs/specs/ai-coach.md §2.13): the
 * latest unread coach message in one line and a Reply button that opens it
 * on `/coach`. Renders nothing while the coach is hidden from the user (AI
 * off or no `ai:use`), while loading, on a failed load, or when every message
 * has been read: it is a prompt, never an error surface.
 */
import { useEffect, useState } from 'react';
import { Avatar, Box, Button, Paper, Typography } from '@mui/material';
import SportsIcon from '@mui/icons-material/Sports';
import { Link as RouterLink } from 'react-router-dom';
import { coachDisplayText, getCoachMessages, type CoachTimelineItem } from '../../services/coach';
import { useCoachVisible } from '../../hooks/useCoachVisible';
import { useIsMounted } from '../../hooks/useIsMounted';
import { stripMarkdown } from '../../utils/markdown';

/** How far back the strip looks for an unread message. */
const HERO_LOOKBACK = 20;

export function latestUnreadCoachMessage(items: CoachTimelineItem[]): CoachTimelineItem | null {
  // The API answers newest first.
  return items.find((item) => item.role === 'coach' && !item.openedAt) ?? null;
}

export function CoachHero() {
  const visible = useCoachVisible();
  const [message, setMessage] = useState<CoachTimelineItem | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!visible) return;
    void getCoachMessages({ limit: HERO_LOOKBACK })
      .then((page) => {
        if (isMounted()) setMessage(latestUnreadCoachMessage(page.items));
      })
      .catch(() => {
        if (isMounted()) setMessage(null);
      });
  }, [visible, isMounted]);

  if (!visible || !message) return null;

  // One line of plain text: markdown (`**19 working sets**`) is stripped, not shown (#343).
  const line = stripMarkdown(
    coachDisplayText(message.title && message.kind !== 'chat' ? `${message.title}: ${message.body}` : message.body),
  );

  return (
    <Paper
      component="section"
      aria-label="From your coach"
      variant="outlined"
      data-testid="coach-hero"
      sx={{
        p: 1.5,
        mb: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minWidth: 0,
        bgcolor: 'primary.container',
        color: 'primary.onContainer',
        borderColor: 'transparent',
      }}
    >
      <Avatar aria-hidden sx={{ bgcolor: 'primary.main', color: 'primary.contrastText', width: 36, height: 36 }}>
        <SportsIcon fontSize="small" />
      </Avatar>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="caption" component="p">
          From your coach
        </Typography>
        <Typography
          variant="body2"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={line}
          data-testid="coach-hero-line"
        >
          {line}
        </Typography>
      </Box>
      <Button
        component={RouterLink}
        to={`/coach?m=${encodeURIComponent(message.id)}`}
        variant="contained"
        size="small"
        sx={{ minHeight: 40, flexShrink: 0 }}
      >
        Reply
      </Button>
    </Paper>
  );
}

export default CoachHero;
