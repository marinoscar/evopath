/**
 * The weekly review card on the `/coach` timeline (E7.10/E7.13, #253;
 * docs/specs/ai-coach.md). Renders a `weekly_review` message whose `data` is
 * the version-1 contract (`parseWeeklyReviewData`): headline, intro, stat
 * tiles (sessions, adherence, weekly streak, check-ins, photos), PRs, the
 * activity goals (`stats.goals`, #269, when present), wins, focus and next
 * week's sessions, plus **Plan my week**, which pre-fills the
 * composer with `prose.nextWeekPlanPrompt` (it never sends on its own).
 *
 * Every number is the server's (`stats`); nothing is computed here beyond
 * formatting. Meaning is always carried by text, never by colour alone.
 */
import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import {
  coachDisplayText,
  type WeeklyReviewData,
  type WeeklyReviewGoal,
  type WeeklyReviewPr,
  type WeeklyStreakChange,
} from '../../services/coach';

/** The short line under the streak tile, by `stats.streakChange`. */
export const WEEKLY_STREAK_CHANGE_LABELS: Record<WeeklyStreakChange, string> = {
  advanced: 'Streak +1',
  pass_used: 'Pass used — streak safe',
  reset: 'Fresh start',
  held: 'Streak held',
};

export const NO_PLAN_LABEL = 'No plan this week';

export interface WeeklyReviewCardProps {
  review: WeeklyReviewData;
  /** Pre-fills the composer with the plan prompt; the button is hidden without it. */
  onPlanWeek?: (prompt: string) => void;
  /** How a distance goal reads (the API speaks meters). Default `km`. */
  distanceUnit?: 'km' | 'mi';
}

const METERS_PER_MILE = 1609.344;
const count = new Intl.NumberFormat('en-US');
const distance = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "3 of 4 sessions", "120 / 150 min", "52,000 / 56,000 steps", "8.2 / 10 km", "5 of 7 days". */
export function formatWeeklyReviewGoalAmount(goal: WeeklyReviewGoal, distanceUnit: 'km' | 'mi' = 'km'): string {
  const { done, target } = goal;
  switch (goal.unit) {
    case 'sessions':
      return `${count.format(done)} of ${count.format(target)} ${target === 1 ? 'session' : 'sessions'}`;
    case 'days':
      return `${count.format(done)} of ${count.format(target)} ${target === 1 ? 'day' : 'days'}`;
    case 'minutes':
      return `${count.format(done)} / ${count.format(target)} min`;
    case 'steps':
      return `${count.format(done)} / ${count.format(target)} steps`;
    case 'meters': {
      // A km-unit target under a kilometre reads in metres, as prescriptions and goals do.
      if (distanceUnit === 'km' && target < 1000) return `${count.format(Math.round(done))} / ${count.format(Math.round(target))} m`;
      const per = distanceUnit === 'mi' ? METERS_PER_MILE : 1000;
      return `${distance.format(done / per)} / ${distance.format(target / per)} ${distanceUnit}`;
    }
  }
}

/** "3-week streak", "5-day streak"; "" for none. */
export function formatWeeklyReviewGoalStreak(goal: WeeklyReviewGoal): string {
  if (goal.streakPeriods <= 0) return '';
  const period = goal.period ?? (goal.unit === 'days' ? 'day' : 'week');
  return `${goal.streakPeriods}-${period} streak`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatWeeklyReviewPr(pr: WeeklyReviewPr): string {
  if (pr.unit === 'reps') return `${pr.exercise}: ${plural(pr.value, 'rep', 'reps')}`;
  return `${pr.exercise}: ${pr.value} kg${pr.reps !== null ? ` × ${pr.reps}` : ''}`;
}

function Tile({ label, value, detail, icon, testId }: { label: string; value: ReactNode; detail?: string; icon?: ReactNode; testId: string }) {
  return (
    <Box
      component="li"
      data-testid={testId}
      sx={{
        listStyle: 'none',
        p: 1,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
      }}
    >
      <Typography variant="caption" color="text.secondary" component="span">
        {label}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        {icon}
        <Typography variant="subtitle1" component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          {value}
        </Typography>
      </Box>
      {detail && (
        <Typography variant="caption" component="span" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {detail}
        </Typography>
      )}
    </Box>
  );
}

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Typography id={id} variant="body2" component="h3" sx={{ fontWeight: 600, mb: 0.5 }}>
      {children}
    </Typography>
  );
}

export function WeeklyReviewCard({ review, onPlanWeek, distanceUnit = 'km' }: WeeklyReviewCardProps) {
  const { stats, prose } = review;
  const idBase = `weekly-review-${review.isoWeek}`;
  const noPlan = stats.noPlan || stats.adherencePct === null;
  const sessions = stats.planned > 0 ? `${stats.completed} of ${stats.planned}` : String(stats.completed);
  const passes = plural(stats.streakPassesLeft, 'pass', 'passes');
  const moreNextWeek = Math.max(0, stats.nextWeekSessions - stats.nextWeek.length);
  const planPrompt = prose.nextWeekPlanPrompt.trim();

  return (
    <Stack spacing={1.5} data-testid="coach-weekly-review" sx={{ minWidth: 0 }}>
      <Box>
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          {prose.headline}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Week {stats.isoWeek.replace(/^\d{4}-W/, '')} · {stats.weekStart} to {stats.weekEnd}
        </Typography>
      </Box>
      {prose.intro && (
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {coachDisplayText(prose.intro)}
        </Typography>
      )}

      <section aria-labelledby={`${idBase}-stats`}>
        <SectionHeading id={`${idBase}-stats`}>This week</SectionHeading>
        <Box
          component="ul"
          sx={{
            m: 0,
            p: 0,
            display: 'grid',
            gap: 1,
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' },
          }}
        >
          <Tile
            testId="coach-review-sessions"
            label="Sessions"
            value={sessions}
            detail={stats.missed > 0 ? `${stats.missed} missed` : undefined}
          />
          <Tile
            testId="coach-review-adherence"
            label="Adherence"
            value={noPlan ? NO_PLAN_LABEL : `${Math.round(stats.adherencePct as number)}%`}
          />
          <Tile
            testId="coach-review-streak"
            label="Weekly streak"
            icon={
              <LocalFireDepartmentIcon
                fontSize="small"
                color={stats.weeklyStreak > 0 ? 'warning' : 'disabled'}
                aria-hidden
              />
            }
            value={`${plural(stats.weeklyStreak, 'week', 'weeks')}`}
            detail={`${WEEKLY_STREAK_CHANGE_LABELS[stats.streakChange]} · ${passes} left`}
          />
          <Tile testId="coach-review-checkins" label="Check-ins" value={stats.checkIns} />
          <Tile testId="coach-review-photos" label="Photos added" value={stats.photosAdded} />
        </Box>
      </section>

      {stats.prs.length > 0 && (
        <section aria-labelledby={`${idBase}-prs`}>
          <SectionHeading id={`${idBase}-prs`}>Personal records</SectionHeading>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {stats.prs.map((pr, i) => (
              <Typography component="li" variant="body2" key={`${pr.exercise}-${i}`} sx={{ overflowWrap: 'anywhere' }}>
                {formatWeeklyReviewPr(pr)}
              </Typography>
            ))}
          </Box>
        </section>
      )}

      {stats.goals && stats.goals.length > 0 && (
        <section aria-labelledby={`${idBase}-goals`}>
          <SectionHeading id={`${idBase}-goals`}>Goals</SectionHeading>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="coach-review-goals">
            {stats.goals.map((goal, i) => {
              const streak = formatWeeklyReviewGoalStreak(goal);
              return (
                <Typography component="li" variant="body2" key={`${goal.title}-${i}`} sx={{ overflowWrap: 'anywhere' }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {goal.title}
                  </Box>
                  {`: ${formatWeeklyReviewGoalAmount(goal, distanceUnit)} · ${goal.hit ? 'Hit' : 'Not hit'}`}
                  {streak && ` · ${streak}`}
                </Typography>
              );
            })}
          </Box>
        </section>
      )}

      {prose.wins.length > 0 && (
        <section aria-labelledby={`${idBase}-wins`}>
          <SectionHeading id={`${idBase}-wins`}>Wins</SectionHeading>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {prose.wins.map((win, i) => (
              <Typography component="li" variant="body2" key={`${i}-${win}`} sx={{ overflowWrap: 'anywhere' }}>
                {coachDisplayText(win)}
              </Typography>
            ))}
          </Box>
        </section>
      )}

      {prose.focus.trim() && (
        <section aria-labelledby={`${idBase}-focus`}>
          <SectionHeading id={`${idBase}-focus`}>Focus</SectionHeading>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {coachDisplayText(prose.focus)}
          </Typography>
        </section>
      )}

      <section aria-labelledby={`${idBase}-next`}>
        <SectionHeading id={`${idBase}-next`}>Next week</SectionHeading>
        {stats.nextWeek.length > 0 ? (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="coach-review-next-week">
            {stats.nextWeek.map((session, i) => (
              <Typography component="li" variant="body2" key={`${session.date}-${i}`} sx={{ overflowWrap: 'anywhere' }}>
                <Box component="time" dateTime={session.date} sx={{ fontWeight: 600 }}>
                  {session.weekday}
                </Box>
                {`: ${session.name}`}
              </Typography>
            ))}
            {moreNextWeek > 0 && (
              <Typography component="li" variant="body2" color="text.secondary">
                and {moreNextWeek} more
              </Typography>
            )}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No sessions planned yet.
          </Typography>
        )}
      </section>

      {onPlanWeek && planPrompt && (
        <Box>
          <Button
            variant="contained"
            size="small"
            startIcon={<EventNoteOutlinedIcon />}
            onClick={() => onPlanWeek(planPrompt)}
            sx={{ minHeight: 44 }}
          >
            Plan my week
          </Button>
        </Box>
      )}
    </Stack>
  );
}

export default WeeklyReviewCard;
