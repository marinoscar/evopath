import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { BottomNav } from '../../../components/navigation/BottomNav';

/**
 * The phone half of the coverage migrated from the deleted `Sidebar.test.tsx`:
 * four items, permission gating, active highlight, navigate-on-click.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

function setPermissions(granted: string[], isAdmin = false) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: (perm: string) => granted.includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin,
  });
}

const ADMIN_PERMISSIONS = ['users:read', 'system_settings:read'];
const PHONE = 375;

/** Renders at a phone width, which is the only width this bar exists at. */
function renderPhone(route = '/') {
  const result = render(<BottomNav />, {
    wrapperOptions: { route, user: mockAdminUser },
  });
  act(() => setViewportWidth(PHONE));
  return result;
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS, true);
    setViewportWidth(PHONE);
  });

  describe('Self-gating', () => {
    it('renders nothing at or above sm, even though Layout also unmounts it there', () => {
      // Belt and braces: `Layout` mounts it only below `sm`, and it refuses to
      // render above `sm` anyway. Either gate alone would be enough; both
      // together mean a future caller cannot mount it into the rail's band.
      render(<BottomNav />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders below sm', () => {
      renderPhone();

      expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    });

    it('appears and disappears across the sm boundary', async () => {
      renderPhone();
      expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();

      await act(async () => setViewportWidth(599));
      expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    });
  });

  describe('Destinations', () => {
    it('renders exactly the four primary destinations for a fully permitted user', () => {
      renderPhone();

      for (const name of ['Today', 'Train', 'Health', 'Gyms']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument();
      }
      // Reached from the user menu on phones, never from the bar.
      for (const name of ['User Settings', 'Console', 'AI Playground']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    });

    it('shows the compact label as visible text but the full label as the accessible name', () => {
      // A 4-up bar at 375px gives each tab ~90px; the full label may not fit.
      renderPhone();

      expect(screen.getByText('Gyms')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Gyms' })).toBeInTheDocument();
    });

    it('never renders more than four actions — showLabels depends on it', () => {
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
      expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(4);
    });

    it('shows the same four buttons to a user without permissions', () => {
      setPermissions([]);
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
      expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    });
  });

  describe('Active state', () => {
    it('selects the destination that owns the route', () => {
      renderPhone('/train');

      expect(screen.getByRole('button', { name: 'Train' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Today' })).not.toHaveClass('Mui-selected');
    });

    it('selects no tab on /settings, which is not a primary destination', () => {
      renderPhone('/settings');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('resolves a child route to its parent destination', () => {
      renderPhone('/health/body');

      expect(screen.getByRole('button', { name: 'Health' })).toHaveClass('Mui-selected');
    });

    it('selects NOTHING on a route no destination owns', () => {
      // `false`, not `null`, is what BottomNavigation wants for "nothing
      // selected" — and an unowned route is exactly where that must show.
      renderPhone('/settingsfoo');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects nothing on a non-primary destination such as Console', () => {
      renderPhone('/admin/settings');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });
  });

  describe('Navigation', () => {
    it('navigates to the destination path on tap', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'Gyms' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Gyms' })).toHaveClass('Mui-selected');
      });
    });

    it('reaches every primary destination', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      for (const name of ['Train', 'Health', 'Gyms', 'Today']) {
        await user.click(screen.getByRole('button', { name }));
        await waitFor(() => {
          expect(screen.getByRole('button', { name })).toHaveClass('Mui-selected');
        });
      }
    });
  });

  /**
   * E7.8 (#248). Coach holds the fourth tab only while the user can see it
   * (AI on AND `ai:use`); otherwise Gyms keeps it. Four tabs in every state.
   */
  describe('Coach or Gyms in the fourth slot (E7.8)', () => {
    function renderPhoneWith(aiEnabled: boolean, route = '/') {
      const result = render(<BottomNav />, { wrapperOptions: { route, user: mockAdminUser, aiEnabled } });
      act(() => setViewportWidth(PHONE));
      return result;
    }

    function tabNames(): string[] {
      return screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    }

    it('shows Today, Train, Health, Coach with AI on and ai:use; Gyms is absent', () => {
      setPermissions(['ai:use']);
      renderPhoneWith(true);
      expect(tabNames()).toEqual(['Today', 'Train', 'Health', 'Coach']);
      expect(screen.queryByRole('button', { name: 'Gyms' })).not.toBeInTheDocument();
    });

    it('shows Today, Train, Health, Gyms with AI off, even to an ai:use holder', () => {
      setPermissions(['ai:use']);
      renderPhoneWith(false);
      expect(tabNames()).toEqual(['Today', 'Train', 'Health', 'Gyms']);
      expect(screen.queryByRole('button', { name: 'Coach' })).not.toBeInTheDocument();
    });

    it('shows Today, Train, Health, Gyms with AI on but without ai:use', () => {
      setPermissions([]);
      renderPhoneWith(true);
      expect(tabNames()).toEqual(['Today', 'Train', 'Health', 'Gyms']);
    });

    it('selects Coach on /coach and navigates to it', async () => {
      setPermissions(['ai:use']);
      renderPhoneWith(true, '/coach');
      expect(screen.getByRole('button', { name: 'Coach' })).toHaveClass('Mui-selected');
    });

    it('selects nothing on /gyms while Coach holds the slot', () => {
      setPermissions(['ai:use']);
      renderPhoneWith(true, '/gyms');
      for (const button of screen.getAllByRole('button')) {
        expect(button).not.toHaveClass('Mui-selected');
      }
    });
  });
});
