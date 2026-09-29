/** The Today "Your gym" card body (E3.3). */
import { describe, it, expect } from 'vitest';
import { render, screen, mockUser } from '../../utils/test-utils';
import { TodayGym } from '../../../components/today/TodayGym';
import { GYMS_UNAVAILABLE } from '../../../services/gyms';
import { DUMBBELLS, ELLIPTICAL, mockEquipment, mockGymDetail, statefulGymsApi } from '../../mocks/fixtures/gyms';

describe('TodayGym', () => {
  it('offers "Add your gym" linking to /gyms/new when there is none', async () => {
    statefulGymsApi([]);
    render(<TodayGym />);
    expect(await screen.findByRole('link', { name: 'Add your gym' })).toHaveAttribute('href', '/gyms/new');
  });

  it("shows the default gym's name and equipment count with an Open link", async () => {
    const home = mockGymDetail({
      name: 'Home Gym',
      isDefault: true,
      equipment: [mockEquipment(DUMBBELLS), mockEquipment(ELLIPTICAL)],
    });
    statefulGymsApi([mockGymDetail({ name: 'Another', isDefault: false }), home]);
    render(<TodayGym />);
    expect(await screen.findByText('Home Gym')).toBeInTheDocument();
    expect(screen.getByText('2 pieces of equipment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Home Gym' })).toHaveAttribute('href', `/gyms/${home.id}`);
  });

  it('says so without gyms:read, and asks nothing of the API', () => {
    render(<TodayGym />, { wrapperOptions: { user: { ...mockUser, permissions: [] } } });
    expect(screen.getByText(GYMS_UNAVAILABLE)).toBeInTheDocument();
  });
});
