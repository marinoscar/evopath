/**
 * TemporaryGymChip (E6.2): "Save {name}?" on `/train` for the most recently
 * changed temporary gym; saving it through the dialog makes it permanent
 * (same id) and the chip goes away. Against the stateful MSW gyms API.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { TemporaryGymChip, latestTemporaryGym } from '../../../components/gyms/TemporaryGymChip';
import { mockGymDetail, statefulGymsApi } from '../../mocks/fixtures/gyms';
import type { GymSummary } from '../../../services/gyms';

const summary = (overrides: Partial<GymSummary>): GymSummary => ({
  ...mockGymDetail(overrides),
  equipmentCount: 0,
  photoCount: 0,
  coverPhotoId: null,
  coverStorageObjectId: null,
  ...overrides,
});

describe('latestTemporaryGym', () => {
  it('picks the temporary gym changed last and ignores permanent ones', () => {
    const gyms = [
      summary({ id: 'a', name: 'Home', isTemporary: false, updatedAt: '2026-09-30T10:00:00.000Z' }),
      summary({ id: 'b', name: 'Old hotel', isTemporary: true, updatedAt: '2026-09-01T10:00:00.000Z' }),
      summary({ id: 'c', name: 'New hotel', isTemporary: true, updatedAt: '2026-09-29T10:00:00.000Z' }),
    ];
    expect(latestTemporaryGym(gyms)?.id).toBe('c');
    expect(latestTemporaryGym([gyms[0]])).toBeNull();
  });
});

describe('TemporaryGymChip', () => {
  it('renders nothing without a temporary gym', async () => {
    const api = statefulGymsApi([mockGymDetail({ name: 'Home Gym' })]);
    render(<TemporaryGymChip />);
    await waitFor(() => expect(api.gyms).toHaveLength(1));
    expect(screen.queryByTestId('temporary-gym-chip')).toBeNull();
  });

  it('renders nothing without gyms:write', async () => {
    statefulGymsApi([mockGymDetail({ name: 'Hotel gym', isTemporary: true, isDefault: false })]);
    render(<TemporaryGymChip />, {
      wrapperOptions: { user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'gyms:write') } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('temporary-gym-chip')).toBeNull();
  });

  it('saves the temporary gym with the same id and disappears', async () => {
    const temp = mockGymDetail({ name: 'Hotel gym Sep 30', type: 'hotel', isTemporary: true, isDefault: false });
    const api = statefulGymsApi([mockGymDetail({ name: 'Home Gym' }), temp]);
    const user = userEvent.setup();
    render(<TemporaryGymChip />);

    const chip = await screen.findByRole('button', { name: 'Save Hotel gym Sep 30?' });
    await user.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Save Hotel gym Sep 30 for future use?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByTestId('temporary-gym-chip')).toBeNull());
    expect(api.calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/gyms/${temp.id}`,
      body: { name: 'Hotel gym Sep 30', type: 'hotel', isTemporary: false },
    });
    expect(api.gyms.find((g) => g.id === temp.id)?.isTemporary).toBe(false);
  });
});
