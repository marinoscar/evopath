import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../../utils/test-utils';
import { ScoreField } from '../../../components/health/ScoreField';

const SCALE = { min: 1, max: 5, lowLabel: 'Drained', highLabel: 'Energised' };

function Controlled({ initial = null, onChange = vi.fn() }: { initial?: number | null; onChange?: (v: number | null) => void }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <ScoreField
      id="energy"
      label="Energy"
      scale={SCALE}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('ScoreField', () => {
  it('names the group with both end labels and shows five buttons', () => {
    render(<Controlled />);
    const group = screen.getByRole('group', { name: 'Energy, 1 Drained to 5 Energised' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(screen.getByText('1 Drained')).toBeInTheDocument();
    expect(screen.getByText('5 Energised')).toBeInTheDocument();
  });

  it('selects a value and announces it as pressed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '4' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    expect(screen.getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the value when the selected button is tapped again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial={3} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '3' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is one tab stop, moved through with the arrow keys and chosen with Space or Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <Controlled onChange={onChange} />
        <button type="button">After</button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: '1' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: '2' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(2);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('disables every button when disabled', () => {
    render(<ScoreField id="e" label="Energy" scale={SCALE} value={2} onChange={vi.fn()} disabled />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled initial={2} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
