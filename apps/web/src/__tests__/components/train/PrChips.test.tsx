/**
 * `PrChips` (E4.4): one text chip per PR type in the API's order, values and
 * the previous best in the user's unit (in the accessible text and the
 * tooltip), "First time logged" without a previous value.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../utils/test-utils';
import {
  PrChips,
  orderedPrs,
  prDescription,
  prPreviousText,
  prValueText,
} from '../../../components/train/PrChips';
import type { SetPr } from '../../../services/workouts';

const weight: SetPr = { type: 'weight', value: 34.019, previous: 31.751 };
const reps: SetPr = { type: 'reps', value: 7, previous: 6 };
const e1rm: SetPr = { type: 'e1rm', value: 80.2, previous: 80 };
const first: SetPr = { type: 'first_time', value: 60, previous: null };

describe('PrChips', () => {
  it('renders nothing without PRs', () => {
    const { container } = render(<PrChips prs={[]} unit="kg" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Weight PR, Rep PR and Est. 1RM PR as text in the API order, one per type', () => {
    render(<PrChips prs={[e1rm, reps, weight, { ...reps }]} unit="kg" />);
    const list = screen.getByRole('list', { name: 'Personal records' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/^Weight PR/);
    expect(items[1]).toHaveTextContent(/^Rep PR/);
    expect(items[2]).toHaveTextContent(/^Est\. 1RM PR/);
    expect(screen.getByText('Weight PR')).toBeVisible();
  });

  it('reads the value and the previous best in the display unit', () => {
    render(<PrChips prs={[weight, reps, e1rm]} unit="lb" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Weight PR: 75.0 lb. Previous best 70.0 lb');
    expect(items[1]).toHaveTextContent('Rep PR: 7 reps. Previous best 6 reps at this weight or heavier');
    expect(items[2]).toHaveTextContent('Est. 1RM PR: 176.8 lb. Previous best est. 1RM 176.4 lb');
  });

  it('shows the previous best in a tooltip', async () => {
    const user = userEvent.setup();
    render(<PrChips prs={[weight]} unit="lb" />);
    await user.hover(screen.getByTestId('pr-chip-weight'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Previous best 70.0 lb');
  });

  it('"First time logged" has no previous value', () => {
    render(<PrChips prs={[first]} unit="kg" />);
    expect(screen.getByRole('listitem')).toHaveTextContent(/^First time logged$/);
  });

  it('helpers format kilograms, reps and the first time', () => {
    expect(prValueText(weight, 'kg')).toBe('34 kg');
    expect(prValueText({ type: 'reps', value: 1, previous: null }, 'kg')).toBe('1 rep');
    expect(prPreviousText(first, 'kg')).toBe('First time this exercise is logged');
    expect(prDescription(e1rm, 'kg')).toBe('Est. 1RM PR: 80.2 kg. Previous best est. 1RM 80 kg');
    expect(orderedPrs([e1rm, first, reps]).map((p) => p.type)).toEqual(['first_time', 'reps', 'e1rm']);
  });
});
