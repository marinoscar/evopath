/**
 * AdaptationReview (E6.1): the AI badge and draft notice, the diff against
 * the planned workout (icons and words), minutes, rationale, assumptions,
 * guardrail notes and the critic verdict; the actions and their refusals
 * (`409 WORKOUT_IN_PROGRESS`, `409 ADAPTATION_STALE`, `403 AI_DISABLED` with
 * Copy exercises); Update my plan disabled without a base; the plan-update
 * Start offer; and the safety stop with no actions.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within } from '../../../utils/test-utils';
import {
  AdaptationReview,
  DRAFT_NOTICE,
  NOT_REVIEWED,
  type AdaptationReviewProps,
} from '../../../../components/training/adapt/AdaptationReview';
import { ApiError } from '../../../../services/api';
import { ADAPT_WORKOUT_ID, mockAdaptation } from '../../../mocks/fixtures/adaptations';
import type { AdaptationView } from '../../../../services/trainingAdaptation';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function renderReview(adaptation: AdaptationView = mockAdaptation(), props: Partial<AdaptationReviewProps> = {}) {
  const handlers = {
    onApplyWorkout: vi.fn().mockResolvedValue({ workoutId: ADAPT_WORKOUT_ID, linkedToPlan: true, planChanged: false }),
    onApplyPlan: vi.fn().mockResolvedValue({ programId: 'p', planVersionId: 'v', versionNumber: 4, changeLogId: 'c' }),
    onDiscard: vi.fn().mockResolvedValue(undefined),
    onAdjustAgain: vi.fn(),
    onStartPlanned: vi.fn().mockResolvedValue(undefined),
    onCopyExercises: vi.fn().mockResolvedValue(undefined),
    onRefetch: vi.fn(),
    ...props,
  };
  const view = render(
    <Routes>
      <Route
        path="/train/adapt/:id"
        element={
          <AdaptationReview
            adaptation={adaptation}
            planned={[
              { slug: 'dumbbell-bench-press', name: 'Dumbbell bench press', sets: 4, repMin: 8, repMax: 10, targetRpe: 8 },
              { slug: 'barbell-row', name: 'Barbell row', sets: 3, repMin: 8, repMax: 8, targetRpe: 8 },
            ]}
            canApplyWorkout
            canApplyPlan
            {...handlers}
          />
        }
      />
      <Route path="*" element={<Where />} />
    </Routes>,
    { wrapperOptions: { route: `/train/adapt/${adaptation.id}`, aiEnabled: true } },
  );
  return { ...view, handlers };
}

/** The confirm dialog has closed (its exit leaves the page inert until then). */
async function dialogGone() {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

function refusal(status: number, reason: string, details: Record<string, unknown> = {}) {
  return new ApiError('Refused', status, reason === 'AI_DISABLED' ? 'AI_DISABLED' : undefined, { reason, ...details });
}

describe('AdaptationReview', () => {
  it('shows the AI badge, the draft notice, minutes, rationale, assumptions, notes and the verdict', async () => {
    const { container } = renderReview();
    expect(screen.getByLabelText('Made by AI')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upper A, 30 minutes with dumbbells' })).toBeInTheDocument();
    expect(screen.getByText(DRAFT_NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId('adapt-minutes')).toHaveTextContent('About 28 min (you asked for 30 min)');
    expect(screen.getByText('Curls dropped to fit 30 minutes.')).toBeInTheDocument();
    expect(screen.getByText('I assumed the dumbbells go up to 30 kg.')).toBeInTheDocument();
    expect(screen.getByText('Reduced sets to fit 30 minutes.')).toBeInTheDocument();
    expect(screen.getByTestId('critic-verdict')).toHaveTextContent('Critic: accepted');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the diff with words, not colour alone', () => {
    renderReview();
    const kept = screen.getByTestId('diff-kept');
    expect(kept).toHaveTextContent('Kept');
    expect(kept).toHaveTextContent('Dumbbell bench press');
    expect(kept).toHaveTextContent('4 × 8–10 @ RPE 8 → 3 × 8–10 @ RPE 7');
    const swapped = screen.getByTestId('diff-swapped');
    expect(swapped).toHaveTextContent('Swapped');
    expect(swapped).toHaveTextContent('Barbell row');
    expect(swapped).toHaveTextContent('replaced by');
    expect(swapped).toHaveTextContent('One-arm dumbbell row');
    expect(screen.getByTestId('diff-added')).toHaveTextContent('AddedPush-up');
    const dropped = screen.getByTestId('diff-dropped');
    expect(dropped).toHaveTextContent('Barbell curl');
    expect(dropped).toHaveTextContent('Reason: Time');
  });

  it('says "Not reviewed by the critic" when the critic was skipped', () => {
    renderReview(mockAdaptation({ criticReport: { verdict: null, checks: null, issues: [], rounds: 0, skipped: 'token_cap' } }));
    expect(screen.getByTestId('critic-verdict')).toHaveTextContent(NOT_REVIEWED);
  });

  it('disables Update my plan with the reason when there was no planned workout', () => {
    renderReview(mockAdaptation({ baseRef: null }));
    expect(screen.getByRole('button', { name: 'Update my plan' })).toBeDisabled();
    expect(screen.getByText('There was no planned workout today, so there is no plan to update.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The workout' })).toBeInTheDocument();
  });

  it('Use for today only confirms, applies and opens the logger', async () => {
    const user = userEvent.setup();
    const { handlers } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Use for today only' }));
    const dialog = screen.getByRole('dialog', { name: 'Use for today only?' });
    await user.click(within(dialog).getByRole('button', { name: 'Start adjusted workout' }));
    expect(handlers.onApplyWorkout).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('where')).toHaveTextContent(`/train/workouts/${ADAPT_WORKOUT_ID}`);
  });

  it('Update my plan applies and offers Start', async () => {
    const user = userEvent.setup();
    const { handlers } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Update my plan' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Update my plan' }));
    const done = await screen.findByRole('dialog', { name: 'Plan updated' });
    expect(done).toHaveTextContent('Version 4 of your plan');
    await user.click(within(done).getByRole('button', { name: 'Start workout' }));
    expect(handlers.onStartPlanned).toHaveBeenCalledTimes(1);
  });

  it('offers Resume on 409 WORKOUT_IN_PROGRESS', async () => {
    const user = userEvent.setup();
    renderReview(mockAdaptation(), {
      onApplyWorkout: vi.fn().mockRejectedValue(refusal(409, 'WORKOUT_IN_PROGRESS', { workoutId: 'w-1' })),
    });
    await user.click(screen.getByRole('button', { name: 'Use for today only' }));
    await user.click(screen.getByRole('button', { name: 'Start adjusted workout' }));
    await dialogGone();
    const alert = await screen.findByTestId('apply-problem-workout_in_progress');
    expect(within(alert).getByRole('link', { name: 'Resume' })).toHaveAttribute('href', '/train/workouts/w-1');
  });

  it('offers Adjust again on 409 ADAPTATION_STALE', async () => {
    const user = userEvent.setup();
    const { handlers } = renderReview(mockAdaptation(), {
      onApplyPlan: vi.fn().mockRejectedValue(refusal(409, 'ADAPTATION_STALE', { findings: [] })),
    });
    await user.click(screen.getByRole('button', { name: 'Update my plan' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Update my plan' }));
    await dialogGone();
    const alert = await screen.findByTestId('apply-problem-stale');
    expect(alert).toHaveTextContent('no longer fits');
    await user.click(within(alert).getByRole('button', { name: 'Adjust again' }));
    expect(handlers.onAdjustAgain).toHaveBeenCalled();
  });

  it('explains 403 AI_DISABLED and offers Copy exercises', async () => {
    const user = userEvent.setup();
    const { handlers } = renderReview(mockAdaptation(), {
      onApplyWorkout: vi.fn().mockRejectedValue(refusal(403, 'AI_DISABLED')),
    });
    await user.click(screen.getByRole('button', { name: 'Use for today only' }));
    await user.click(screen.getByRole('button', { name: 'Start adjusted workout' }));
    await dialogGone();
    const alert = await screen.findByTestId('apply-problem-ai_disabled');
    expect(alert).toHaveTextContent("AI was turned off; the adapted workout can't be started from here");
    await user.click(within(alert).getByRole('button', { name: 'Copy exercises' }));
    expect(handlers.onCopyExercises).toHaveBeenCalledTimes(1);
  });

  it('shows the guidance card and no actions when stopped for safety', () => {
    renderReview(mockAdaptation({ status: 'blocked_safety', proposal: null, guidance: 'Stop and seek medical care now.' }));
    expect(screen.getByTestId('adapt-guidance')).toHaveTextContent('Stop and seek medical care now.');
    expect(screen.queryByRole('button', { name: 'Use for today only' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjust again' })).toBeNull();
  });

  it('links to the workout once applied, without the apply actions', () => {
    renderReview(mockAdaptation({ status: 'applied', appliedAs: 'one_off', appliedWorkoutId: ADAPT_WORKOUT_ID }));
    expect(screen.getByRole('link', { name: 'Open workout' })).toHaveAttribute('href', `/train/workouts/${ADAPT_WORKOUT_ID}`);
    expect(screen.queryByRole('button', { name: 'Use for today only' })).toBeNull();
  });
});
