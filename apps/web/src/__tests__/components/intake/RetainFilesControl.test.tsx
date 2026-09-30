/**
 * `RetainFilesControl` (H1, #185): the keep-or-delete choice on a health
 * upload. Checked means keep; the helper text is its description; nothing
 * renders for a non-health intake kind.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { APP_NAME } from '@app/shared';
import { render, screen } from '../../utils/test-utils';
import {
  RetainFilesControl,
  RETAIN_FILES_HELPER_TEXT,
  RETAIN_FILES_LABEL,
} from '../../../components/intake';
import { isHealthIntakeKind } from '../../../services/intake';

describe('RetainFilesControl', () => {
  it('names the product in its label and describes itself with the helper text', () => {
    render(<RetainFilesControl kind="body_metric_reading" checked onChange={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: `Keep this file in ${APP_NAME} after processing` });
    expect(RETAIN_FILES_LABEL).toBe(`Keep this file in ${APP_NAME} after processing`);
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(RETAIN_FILES_HELPER_TEXT);
    expect(RETAIN_FILES_HELPER_TEXT).toMatch(/erased/);
  });

  it('reports the new choice when toggled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<RetainFilesControl kind="body_metric_reading" checked onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: RETAIN_FILES_LABEL }));
    expect(onChange).toHaveBeenLastCalledWith(false);

    rerender(<RetainFilesControl kind="body_metric_reading" checked={false} onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: RETAIN_FILES_LABEL }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('is disabled when asked', () => {
    render(<RetainFilesControl kind="body_metric_reading" checked onChange={vi.fn()} disabled />);
    expect(screen.getByRole('checkbox', { name: RETAIN_FILES_LABEL })).toBeDisabled();
  });

  it.each(['gym_equipment', 'workout_prefill', '', null, undefined])(
    'renders nothing for the non-health kind %s',
    (kind) => {
      render(<RetainFilesControl kind={kind} checked onChange={vi.fn()} />);
      expect(screen.queryByTestId('retain-files-control')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    },
  );

  it('knows the health kinds', () => {
    expect(isHealthIntakeKind('body_metric_reading')).toBe(true);
    expect(isHealthIntakeKind('gym_equipment')).toBe(false);
    expect(isHealthIntakeKind('workout_prefill')).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(<RetainFilesControl kind="body_metric_reading" checked onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
