/**
 * SaveGymPrompt / SaveGymForm / SaveGymDialog (E6.2): "Save {name} for
 * future use?" with Save gym (rename and retype) and Not now, the
 * name-collision warning, and the gyms API refusals in words.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../../utils/test-utils';
import { ApiError } from '../../../services/api';
import { GYM_LIMIT_MESSAGE } from '../../../services/gyms';
import {
  SaveGymDialog,
  SaveGymPrompt,
  nameCollision,
  type SaveGymTarget,
} from '../../../components/gyms/SaveGymPrompt';

const GYM: SaveGymTarget = { id: 'gym-temp', name: 'Hotel gym Sep 30', type: 'hotel' };
const OTHERS = [
  { id: 'gym-home', name: 'Home Gym' },
  { id: 'gym-temp', name: 'Hotel gym Sep 30' },
];

describe('nameCollision', () => {
  it('matches another gym by trimmed, case-insensitive name, never itself', () => {
    expect(nameCollision('  home gym ', 'gym-temp', OTHERS)).toBe('Home Gym');
    expect(nameCollision('Hotel gym Sep 30', 'gym-temp', OTHERS)).toBeNull();
    expect(nameCollision('', 'gym-temp', OTHERS)).toBeNull();
  });
});

describe('SaveGymPrompt', () => {
  it('asks the question and saves with the new name and type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = render(<SaveGymPrompt gym={GYM} otherGyms={OTHERS} onSave={onSave} />);

    const prompt = screen.getByRole('region', { name: 'Save Hotel gym Sep 30 for future use?' });
    expect(prompt).toHaveTextContent('deleted 30 days after its last change unless you save it');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(within(prompt).getByRole('button', { name: 'Save gym' }));
    const name = screen.getByRole('textbox', { name: /Name/ });
    expect(name).toHaveValue('Hotel gym Sep 30');
    await user.clear(name);
    await user.type(name, 'Marriott Lisbon');
    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Club' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({ name: 'Marriott Lisbon', type: 'club' });
    const saved = await screen.findByTestId('save-gym-saved');
    expect(saved).toHaveTextContent('Saved. Marriott Lisbon is in your gyms.');
    expect(within(saved).getByRole('link', { name: 'Open gym' })).toHaveAttribute('href', '/gyms/gym-temp');
  });

  it('Not now leaves it temporary and says where to save it later', async () => {
    const onSave = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<SaveGymPrompt gym={GYM} onSave={onSave} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    const note = screen.getByTestId('save-gym-dismissed');
    expect(note).toHaveTextContent('Hotel gym Sep 30 stays temporary. You can still save it from Gyms.');
    expect(within(note).getByRole('link', { name: 'Gyms' })).toHaveAttribute('href', '/gyms');
  });

  it('warns on a name another gym already has, without blocking the save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SaveGymPrompt gym={GYM} otherGyms={OTHERS} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Save gym' }));
    const name = screen.getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'home gym');
    expect(screen.getByTestId('save-gym-collision')).toHaveTextContent(
      'You already have a gym called Home Gym. Both are kept; they are not merged.',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ name: 'home gym', type: 'hotel' });
  });

  it('refuses an empty name before the round trip', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<SaveGymPrompt gym={GYM} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Save gym' }));
    await user.clear(screen.getByRole('textbox', { name: /Name/ }));
    expect(screen.getByText('Give the gym a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('explains GYM_LIMIT with a link to the gyms page and keeps the form open', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new ApiError('You can have at most 50 gyms', 400, 'BAD_REQUEST', { reason: 'GYM_LIMIT', max: 50 }));
    const user = userEvent.setup();
    render(<SaveGymPrompt gym={GYM} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Save gym' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GYM_LIMIT_MESSAGE);
    expect(within(alert).getByRole('link', { name: 'Open gyms' })).toHaveAttribute('href', '/gyms');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('SaveGymDialog', () => {
  it('saves and closes; Cancel closes without saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<SaveGymDialog open gym={GYM} onSave={onSave} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Save Hotel gym Sep 30 for future use?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();

    rerender(<SaveGymDialog open gym={GYM} onSave={onSave} onClose={onClose} />);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ name: 'Hotel gym Sep 30', type: 'hotel' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
