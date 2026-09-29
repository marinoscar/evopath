/**
 * Personal-record chips (E4.4): "Weight PR", "Rep PR", "Est. 1RM PR" and
 * "First time logged", as the API computed them for a set. The label is text
 * (never colour alone); the tooltip and the accessible name carry the new
 * value and the previous best, in the user's unit.
 */
import { Box, Chip, Tooltip } from '@mui/material';
import { EmojiEvents as TrophyIcon, FiberNew as NewIcon } from '@mui/icons-material';
import type { PrType, SetPr } from '../../services/workouts';
import { PR_TYPES } from '../../services/workouts';
import { formatWeight, type WeightUnit } from '../../utils/units';

/** Present for screen readers, absent on screen. */
export const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

export const PR_LABEL: Record<PrType, string> = {
  weight: 'Weight PR',
  reps: 'Rep PR',
  e1rm: 'Est. 1RM PR',
  first_time: 'First time logged',
};

function repsText(n: number): string {
  return `${n} ${n === 1 ? 'rep' : 'reps'}`;
}

/** The new value of a PR as the user reads it: `'75.0 lb'`, `'11 reps'`, `'84 kg'`. */
export function prValueText(pr: SetPr, unit: WeightUnit): string {
  return pr.type === 'reps' ? repsText(pr.value) : formatWeight(pr.value, unit);
}

/** What the PR beats: `'Previous best 70.0 lb'`; the first time says so. */
export function prPreviousText(pr: SetPr, unit: WeightUnit): string {
  if (pr.type === 'first_time' || pr.previous === null) return 'First time this exercise is logged';
  switch (pr.type) {
    case 'weight':
      return `Previous best ${formatWeight(pr.previous, unit)}`;
    case 'reps':
      return `Previous best ${repsText(pr.previous)} at this weight or heavier`;
    case 'e1rm':
      return `Previous best est. 1RM ${formatWeight(pr.previous, unit)}`;
  }
}

/** One sentence per PR, for the accessible name and announcements. */
export function prDescription(pr: SetPr, unit: WeightUnit): string {
  if (pr.type === 'first_time') return `${PR_LABEL.first_time}`;
  return `${PR_LABEL[pr.type]}: ${prValueText(pr, unit)}. ${prPreviousText(pr, unit)}`;
}

/** PRs in the API's reporting order, one per type. */
export function orderedPrs<T extends SetPr>(prs: readonly T[]): T[] {
  const seen = new Set<PrType>();
  return [...prs]
    .sort((a, b) => PR_TYPES.indexOf(a.type) - PR_TYPES.indexOf(b.type))
    .filter((pr) => (seen.has(pr.type) ? false : (seen.add(pr.type), true)));
}

export interface PrChipsProps {
  prs: readonly SetPr[];
  unit: WeightUnit;
}

export function PrChips({ prs, unit }: PrChipsProps) {
  const list = orderedPrs(prs);
  if (list.length === 0) return null;
  return (
    <Box component="ul" aria-label="Personal records" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, p: 0, m: 0, listStyle: 'none' }}>
      {list.map((pr) => {
        const first = pr.type === 'first_time';
        return (
          <Box component="li" key={pr.type}>
            <Tooltip title={prPreviousText(pr, unit)} describeChild enterTouchDelay={0}>
              <Chip
                size="small"
                color={first ? 'default' : 'success'}
                variant={first ? 'outlined' : 'filled'}
                icon={first ? <NewIcon aria-hidden /> : <TrophyIcon aria-hidden />}
                label={
                  <>
                    {PR_LABEL[pr.type]}
                    {!first && (
                      <Box component="span" sx={visuallyHidden}>
                        {`: ${prValueText(pr, unit)}. ${prPreviousText(pr, unit)}`}
                      </Box>
                    )}
                  </>
                }
                data-testid={`pr-chip-${pr.type}`}
              />
            </Tooltip>
          </Box>
        );
      })}
    </Box>
  );
}
