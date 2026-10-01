/**
 * `CoachComposer` (E7.8, #248): quick replies are buttons that send their
 * text, the text field is labelled and capped at 2,000 characters, Enter
 * sends, and offline disables everything with the reason shown.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { CoachComposer, COACH_OFFLINE_TEXT } from '../../../components/coach/CoachComposer';
import { COACH_CHAT_TEXT_MAX, COACH_QUICK_REPLIES } from '../../../services/coach';

describe('CoachComposer', () => {
  it('offers the five quick replies as buttons, in order', () => {
    render(<CoachComposer onSend={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Quick replies' });
    expect(group).toBeInTheDocument();
    expect([...COACH_QUICK_REPLIES]).toEqual([
      'Motivate me',
      'I missed — now what?',
      'Adjust this week',
      "I'm sick",
      'How am I doing?',
    ]);
    for (const reply of COACH_QUICK_REPLIES) {
      expect(screen.getByRole('button', { name: reply })).toBeInTheDocument();
    }
  });

  it('sends a quick reply as its text', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<CoachComposer onSend={onSend} />);
    await user.click(screen.getByRole('button', { name: "I'm sick" }));
    expect(onSend).toHaveBeenCalledWith("I'm sick");
  });

  it('sends the trimmed draft with Enter and clears it; Shift+Enter breaks the line', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<CoachComposer onSend={onSend} />);
    const field = screen.getByRole('textbox', { name: 'Message your coach' });
    await user.type(field, '  hello{Shift>}{Enter}{/Shift}there  ');
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello\nthere');
    expect(field).toHaveValue('');
  });

  it('caps the draft at the API limit', () => {
    render(<CoachComposer onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Message your coach' })).toHaveAttribute(
      'maxlength',
      String(COACH_CHAT_TEXT_MAX),
    );
    expect(screen.getByText(`0 / ${COACH_CHAT_TEXT_MAX}`)).toBeInTheDocument();
  });

  it('disables Send while empty or busy', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CoachComposer onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Message your coach' }), 'hi');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    rerender(<CoachComposer onSend={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables everything offline and says why', () => {
    render(<CoachComposer onSend={vi.fn()} offline />);
    expect(screen.getByRole('textbox', { name: 'Message your coach' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Motivate me' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(COACH_OFFLINE_TEXT)).toBeInTheDocument();
  });

  it('has an accessible name and no axe violations', async () => {
    const { container } = render(<CoachComposer onSend={vi.fn()} />);
    expect(screen.getByRole('form', { name: 'Message your coach' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
