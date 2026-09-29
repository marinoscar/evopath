/** `WorkoutHeader` and `WorkoutSummaryDialog` (E4.3). */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../utils/test-utils';
import { WorkoutHeader, NO_GYM_CHIP } from '../../../components/train/WorkoutHeader';
import { WorkoutSummaryDialog } from '../../../components/train/WorkoutSummaryDialog';
import { mockGymDetail, toSummary } from '../../mocks/fixtures/gyms';
import { mockWorkout } from '../../mocks/fixtures/workouts';

const home = toSummary(mockGymDetail({ name: 'Home Gym' }));
const hotel = toSummary(mockGymDetail({ name: 'Hotel', isDefault: false }));

function renderHeader(overrides: Partial<Parameters<typeof WorkoutHeader>[0]> = {}) {
  const props = {
    workout: mockWorkout({ name: 'Push day', gym: { id: home.id, name: home.name } }),
    canWrite: true,
    gyms: [home, hotel],
    onRename: vi.fn().mockResolvedValue(undefined),
    onChangeGym: vi.fn().mockResolvedValue(undefined),
    onFinish: vi.fn(),
    ...overrides,
  };
  render(<WorkoutHeader {...props} />);
  return props;
}

describe('WorkoutHeader', () => {
  it('renames inline with the keyboard', async () => {
    const user = userEvent.setup();
    const props = renderHeader();
    await user.click(screen.getByRole('button', { name: 'Rename workout' }));
    const field = screen.getByRole('textbox', { name: 'Workout name' });
    await user.clear(field);
    await user.type(field, 'Upper body{Enter}');
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith('Upper body'));
  });

  it('changes the gym from the chip, or clears it', async () => {
    const user = userEvent.setup();
    const props = renderHeader();
    await user.click(screen.getByRole('button', { name: 'Gym: Home Gym. Change gym' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hotel' }));
    expect(props.onChangeGym).toHaveBeenCalledWith(hotel.id);
    await user.click(screen.getByRole('button', { name: 'Gym: Home Gym. Change gym' }));
    await user.click(screen.getByRole('menuitem', { name: 'No gym / bodyweight' }));
    expect(props.onChangeGym).toHaveBeenLastCalledWith(null);
  });

  it('reads "No gym" when the workout has none (or its gym was deleted)', () => {
    renderHeader({ workout: mockWorkout({ gym: null }) });
    expect(screen.getByText(NO_GYM_CHIP)).toBeInTheDocument();
  });

  it('runs a timer that is not announced', () => {
    renderHeader();
    expect(screen.getByRole('timer', { name: 'Elapsed time' })).toHaveAttribute('aria-live', 'off');
  });

  it('completed: shows Completed, Edit details and Delete workout, no Finish or timer', () => {
    renderHeader({
      workout: mockWorkout({ status: 'completed', durationSeconds: 3600 }),
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete workout' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
  });
});

describe('WorkoutSummaryDialog', () => {
  it('shows duration, exercises, sets and volume in the display unit', () => {
    const workout = mockWorkout({
      status: 'completed',
      summary: { durationSeconds: 3900, exerciseCount: 2, setCount: 6, volumeKg: 920.779 },
    });
    render(<WorkoutSummaryDialog open workout={workout} unit="lb" onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Workout finished' });
    expect(dialog).toHaveTextContent('Duration1 h 05 min');
    expect(dialog).toHaveTextContent('Exercises2');
    expect(dialog).toHaveTextContent('Sets6');
    expect(dialog).toHaveTextContent(`Volume${(2030).toLocaleString()} lb`);
  });
});
