/**
 * The daily check-in dialog (issue #56, E2.4). What it hands `onSave` is
 * asserted, not just what it shows: the API replaces the whole day, so an
 * omitted score must go out as `null`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import {
  CHECK_IN_CONFLICT_MESSAGE,
  CheckInDialog,
  type CheckInDialogProps,
} from '../../../components/health/CheckInDialog';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import { ApiError } from '../../../services/api';
import { mockCheckIn } from '../../mocks/fixtures/checkIns';

function renderDialog(props: Partial<CheckInDialogProps> = {}, options: Parameters<typeof render>[1] = {}) {
  const handlers = {
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(mockCheckIn()),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onConflict: vi.fn(),
  };
  const view = render(
    <CheckInDialog open date="2026-09-29" checkIn={null} {...handlers} {...props} />,
    options,
  );
  return { ...view, ...handlers };
}

const group = (name: RegExp) => screen.getByRole('group', { name });
const pick = (name: RegExp, n: number) => within(group(name)).getByRole('button', { name: String(n) });

describe('CheckInDialog', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });
  afterEach(() => {
    resetViewportWidth();
  });

  it('shows the title, the day it saves to and four named score groups from the catalog', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Daily check-in' });
    expect(dialog).toHaveAccessibleDescription(/September 29/);
    expect(await screen.findByRole('group', { name: 'Energy, 1 Drained to 5 Energised' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Sleep quality, 1 Poor to 5 Great' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Muscle soreness, 1 None to 5 Severe' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Stress, 1 Calm to 5 Overwhelmed' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeInTheDocument();
    expect(screen.getByText('0/500')).toBeInTheDocument();
    // A new check-in has nothing to delete.
    expect(screen.queryByRole('button', { name: 'Delete check-in' })).toBeNull();
  });

  it('keeps Save disabled until a score is chosen, and again when it is cleared', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole('group', { name: /^Energy/ });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(screen.getByText('Choose at least one score to save.')).toBeInTheDocument();

    await user.click(pick(/^Energy/, 4));
    expect(save).toBeEnabled();
    await user.click(pick(/^Energy/, 4));
    expect(save).toBeDisabled();
  });

  it('creates a check-in: four scores and a trimmed note, saved to the dialog date', async () => {
    const user = userEvent.setup();
    const { onSave, onClose } = renderDialog();
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Energy/, 4));
    await user.click(pick(/^Sleep quality/, 3));
    await user.click(pick(/^Muscle soreness/, 2));
    await user.click(pick(/^Stress/, 3));
    await user.type(screen.getByRole('textbox', { name: 'Note' }), '  Big presentation  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('2026-09-29', {
      energy: 4,
      sleepQuality: 3,
      soreness: 2,
      stress: 3,
      note: 'Big presentation',
    });
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText('Check-in saved')).toBeInTheDocument();
  });

  it('sends a whitespace-only note as null and unchosen scores as null', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Stress/, 1));
    await user.type(screen.getByRole('textbox', { name: 'Note' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('2026-09-29', {
        energy: null,
        sleepQuality: null,
        soreness: null,
        stress: 1,
        note: null,
      }),
    );
  });

  it('edits: prefilled from the stored day, one change, the rest kept', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ checkIn: mockCheckIn() });
    await screen.findByRole('group', { name: /^Energy/ });
    expect(pick(/^Energy/, 4)).toHaveAttribute('aria-pressed', 'true');
    expect(pick(/^Stress/, 3)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Big presentation');

    await user.click(pick(/^Stress/, 3)); // clear it
    await user.click(pick(/^Energy/, 5));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('2026-09-29', {
        energy: 5,
        sleepQuality: 3,
        soreness: 2,
        stress: null,
        note: 'Big presentation',
      }),
    );
  });

  it('deletes only after a confirmation', async () => {
    const user = userEvent.setup();
    const { onDelete, onClose } = renderDialog({ checkIn: mockCheckIn() });
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(screen.getByRole('button', { name: 'Delete check-in' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this day's check-in?")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText("Delete this day's check-in?")).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete check-in' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('2026-09-29'));
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText('Check-in deleted')).toBeInTheDocument();
  });

  it('on a 409 says the day was updated elsewhere, asks for a reload and re-fills from it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new ApiError('Conflict', 409));
    const { onConflict, onClose, rerender } = renderDialog({ onSave, checkIn: mockCheckIn() });
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Energy/, 1));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(CHECK_IN_CONFLICT_MESSAGE)).toBeInTheDocument();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // The parent reloads the day: the dialog shows the other device's values.
    rerender(
      <CheckInDialog
        open
        date="2026-09-29"
        checkIn={mockCheckIn({ energy: 2, updatedAt: '2026-09-29T09:00:00.000Z' })}
        onClose={onClose}
        onSave={onSave}
        onDelete={vi.fn()}
        onConflict={onConflict}
      />,
    );
    await waitFor(() => expect(pick(/^Energy/, 2)).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText(CHECK_IN_CONFLICT_MESSAGE)).toBeInTheDocument();
  });

  it('shows the API message for a rejected day (outside the window)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(
      new ApiError('date must be within the last 7 days', 400, 'VALIDATION_ERROR', {
        issues: [{ path: 'date', message: 'date must be within the last 7 days' }],
      }),
    );
    renderDialog({ onSave });
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Energy/, 3));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('date must be within the last 7 days')).toBeInTheDocument();
  });

  it('puts a note issue under the note field', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(
      new ApiError('Invalid', 400, 'VALIDATION_ERROR', {
        issues: [{ path: 'note', message: 'note must be at most 500 characters' }],
      }),
    );
    renderDialog({ onSave });
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Energy/, 3));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('note must be at most 500 characters')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains a network failure', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog({ onSave });
    await screen.findByRole('group', { name: /^Energy/ });
    await user.click(pick(/^Energy/, 3));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save. Check your connection and try again.')).toBeInTheDocument();
  });

  it('shows an error when the catalog cannot be loaded', async () => {
    server.use(http.get('*/api/measurements/metrics', () => HttpResponse.error()));
    renderDialog();
    expect(
      await screen.findByText('Could not load the check-in scales. Close this dialog and try again later.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the same error when the catalog has no wellness scales', async () => {
    server.use(
      http.get('*/api/measurements/metrics', () =>
        HttpResponse.json({ data: { metrics: [], methods: [] } }),
      ),
    );
    renderDialog();
    expect(
      await screen.findByText('Could not load the check-in scales. Close this dialog and try again later.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('is full-screen on a phone', async () => {
    setViewportWidth(375);
    renderDialog();
    await screen.findByRole('group', { name: /^Energy/ });
    expect(document.querySelector('.MuiDialog-paperFullScreen')).not.toBeNull();
  });

  it('is not full-screen on a desktop', async () => {
    renderDialog();
    await screen.findByRole('group', { name: /^Energy/ });
    expect(document.querySelector('.MuiDialog-paperFullScreen')).toBeNull();
  });

  it('does not open without health_data:write', () => {
    renderDialog({}, { wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no axe violations', async () => {
    renderDialog({ checkIn: mockCheckIn() });
    await screen.findByRole('group', { name: /^Energy/ });
    const results = await axe(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
