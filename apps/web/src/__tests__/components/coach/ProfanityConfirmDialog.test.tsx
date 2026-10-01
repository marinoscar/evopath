/**
 * `ProfanityConfirmDialog` (E7.3, #243; docs/specs/ai-coach.md §2.4): states
 * the content is adult language and that insults target effort only; the 18+
 * confirmation is never pre-checked and gates the confirm button.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { ProfanityConfirmDialog } from '../../../components/coach/ProfanityConfirmDialog';

function renderDialog(props: Partial<Parameters<typeof ProfanityConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(<ProfanityConfirmDialog open onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  return { onConfirm, onCancel, ...result };
}

describe('ProfanityConfirmDialog', () => {
  it('explains adult language and effort-only insults', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Turn on adult language?' });
    expect(dialog).toHaveTextContent(/uncensored profanity/);
    expect(dialog).toHaveTextContent(/about effort and excuses only/);
    expect(dialog).toHaveTextContent(/never comments on your body, weight, health or identity/);
  });

  it('starts unchecked and enables confirm only once the box is ticked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const checkbox = screen.getByRole('checkbox', { name: 'I confirm I am 18 or older' });
    const confirm = screen.getByRole('button', { name: 'Turn on adult language' });
    expect(checkbox).not.toBeChecked();
    expect(confirm).toBeDisabled();
    await user.click(checkbox);
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without confirming', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('resets the confirmation each time it opens', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog();
    await user.click(screen.getByRole('checkbox'));
    rerender(<ProfanityConfirmDialog open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    rerender(<ProfanityConfirmDialog open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole('checkbox', { name: 'I confirm I am 18 or older' })).not.toBeChecked();
  });

  it('disables both buttons while busy', () => {
    renderDialog({ busy: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Turning on…' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    renderDialog();
    const results = await axe(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
