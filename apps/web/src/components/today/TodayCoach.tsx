/**
 * The Today `coach` card (E7.8, #248): its Gate and its Content.
 *
 * `CoachGate` shows the card only while the coach is visible to the user (the
 * `coach` destination's own answer: `ai:use` AND AI on). `TodayCoach` shows
 * this week's target and the streak from `GET /api/coach/state` as sent; for a
 * user the state route refuses (it also needs `programs:read`) the card is a
 * plain invitation to chat.
 */
import type { ReactNode } from 'react';
import { Box, Skeleton, Typography } from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import { useCoachVisible } from '../../hooks/useCoachVisible';
import { useCoachState } from '../../hooks/useCoachState';
import { weeklyTargetText } from '../coach/CoachHeader';

export function CoachGate({ children }: { children: ReactNode }) {
  return useCoachVisible() ? <>{children}</> : null;
}

export function TodayCoach() {
  const { state, isLoading } = useCoachState();

  if (isLoading) return <Skeleton variant="rounded" height={48} aria-label="Loading coach" />;

  if (!state) {
    return (
      <Typography color="text.secondary">
        Ask your coach anything about your training, or get a nudge when it counts.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Typography data-testid="today-coach-target">{weeklyTargetText(state.weeklyTarget)}</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <LocalFireDepartmentIcon fontSize="small" color={state.weeklyStreak > 0 ? 'warning' : 'disabled'} aria-hidden />
        <Typography variant="body2" color="text.secondary">
          {state.weeklyStreak}-week streak
        </Typography>
      </Box>
      {state.unreadCount > 0 && (
        <Typography variant="body2" color="text.secondary">
          {state.unreadCount} unread {state.unreadCount === 1 ? 'message' : 'messages'}
        </Typography>
      )}
    </Box>
  );
}
