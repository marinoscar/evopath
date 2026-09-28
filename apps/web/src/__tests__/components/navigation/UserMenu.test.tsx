import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { UserMenu } from '../../../components/navigation/UserMenu';
import { DESTINATIONS } from '../../../config/destinations';

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - viewer user
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['user_settings:read', 'user_settings:write']),
      roles: new Set(['viewer']),
      hasPermission: (perm: string) =>
        perm === 'user_settings:read' || perm === 'user_settings:write',
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
  });

  describe('Rendering', () => {
    it('should display user avatar button', () => {
      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display user initials when no profile image', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            profileImageUrl: null,
            displayName: 'Test User' as string | null,
          },
        },
      });

      // Avatar should contain initials
      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display first letter of email when no display name', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should not render when user is null', () => {
      render(<UserMenu />, {
        wrapperOptions: { authenticated: false },
      });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Menu Interaction', () => {
    it('should open menu on click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('should display user email in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      });
    });

    it('should display user display name in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Custom Display Name',
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Custom Display Name')).toBeInTheDocument();
      });
    });

    it('should show placeholder when no display name', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(/no name set/i)).toBeInTheDocument();
      });
    });

    it('should close menu when clicking outside', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // Click outside (on document body)
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Menu Items', () => {
    it('should have settings menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
      });
    });

    it('should have logout menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /logout/i })).toBeInTheDocument();
      });
    });

    it('should show the Console entry for admin users', async () => {
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserMenu />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /console/i })).toBeInTheDocument();
      });
    });

    it('should NOT show the Console entry for non-admin users', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      expect(screen.queryByRole('menuitem', { name: /console/i })).not.toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to settings page', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
      });

      const settingsItem = screen.getByRole('menuitem', { name: /settings/i });
      await user.click(settingsItem);

      // Menu should close after navigation
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('should navigate to the Console for admins', async () => {
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserMenu />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /console/i })).toBeInTheDocument();
      });

      const consoleItem = screen.getByRole('menuitem', { name: /console/i });
      await user.click(consoleItem);

      // Menu should close after navigation
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Logout', () => {
    it('should call logout on logout click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /logout/i })).toBeInTheDocument();
      });

      const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
      await user.click(logoutItem);

      // Logout should be triggered
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Icons', () => {
    it('should display settings icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const settingsItem = screen.getByRole('menuitem', { name: /settings/i });
        expect(settingsItem).toBeInTheDocument();
      });
    });

    it('should display logout icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
        expect(logoutItem).toBeInTheDocument();
      });
    });

    it('should display the admin icon for the Console entry', async () => {
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserMenu />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const consoleItem = screen.getByRole('menuitem', { name: /console/i });
        expect(consoleItem).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toHaveAttribute('aria-haspopup', 'true');
      // aria-expanded is undefined when menu is closed (not set)
      expect(avatarButton).not.toHaveAttribute('aria-expanded');

      await user.click(avatarButton);

      await waitFor(() => {
        expect(avatarButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('should have menu ID', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        // MUI Menu puts the id on the presentation wrapper, not the menu role element
        const menuWrapper = document.getElementById('user-menu');
        expect(menuWrapper).toBeInTheDocument();
        // Verify the menu role element exists inside
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });
  });

  describe('Sourced from the destination table', () => {
    /**
     * Issue #55. This menu already gated System Settings on
     * `system_settings:read` while the sidebar gated the same page on the
     * `admin` ROLE — so a Contributor granted that permission saw the menu
     * entry, reached a working page, and had no sidebar row. Both surfaces now
     * read `config/destinations.ts`, so there is one answer per destination.
     */
    function setPermissions(granted: string[], isAdmin = false) {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(granted),
        roles: new Set(isAdmin ? ['admin'] : ['contributor']),
        hasPermission: (perm: string) => granted.includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin,
      });
    }

    it('shows Console to a non-admin holding system_settings:read', async () => {
      // The exact user the old split-brain stranded.
      const user = userEvent.setup();
      setPermissions(['system_settings:read'], false);

      render(<UserMenu />);
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'Console' })).toBeInTheDocument();
      });
    });

    it('shows Console to a user holding users:read alone', async () => {
      // #92 merged the two admin destinations into one gated on EITHER
      // permission. Both halves of that `anyPermission` are asserted — a gate
      // that silently kept only the first would pass the test above and fail
      // this one.
      const user = userEvent.setup();
      setPermissions(['users:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'Console' })).toBeInTheDocument();
      });
    });

    it('grants nothing on the admin role alone', async () => {
      const user = userEvent.setup();
      setPermissions([], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(screen.queryByRole('menuitem', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('omits Home — the AppBar brand already routes there', async () => {
      // A menu row duplicating on-screen chrome is the bloat this epic removes.
      const user = userEvent.setup();
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(screen.queryByRole('menuitem', { name: 'Home' })).not.toBeInTheDocument();
    });

    it('labels and targets every entry from the destination table', async () => {
      const user = userEvent.setup();
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // Feature-gated destinations (`ai`, #425) are absent with no feature
      // provider above the menu — AI is off, failing closed.
      const expected = DESTINATIONS.filter((d) => d.key !== 'home' && !d.feature).map(
        (d) => d.label,
      );
      for (const label of expected) {
        expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
      }
      // The destinations plus Logout, and nothing invented locally.
      expect(screen.getAllByRole('menuitem')).toHaveLength(expected.length + 1);
    });
  });

  /**
   * The version line — issue #401, epic #397.
   *
   * ⚠ THIS SUITE IS WHAT CATCHES A DEFINE MISSING FROM THE TEST CONFIG.
   * `__APP_VERSION__` is substituted by `appVersionDefine()` in
   * `build-config/app-version.ts`, which `vite.config.ts`, `vitest.config.ts` AND
   * `visual/vite.config.ts` each have to spread — three files with no shared
   * base. A define present only in the build config leaves the constant a free
   * identifier here, and every test below dies with `__APP_VERSION__ is not
   * defined` rather than on an assertion. That is exactly the signal wanted:
   * the define missing from the test config is a real bug (the visual harness
   * breaks the same way, on a blank page), not an environment quirk to stub
   * around.
   *
   * It is asserted as A REAL STRING rather than against a literal, because the
   * literal is whatever `apps/web/package.json` — or the build environment's
   * `APP_VERSION` — says today, and pinning it would make every release bump a
   * test failure. That is the same trap `tests/visual/support/harness.ts`
   * documents for the pixel baselines, and this epic's own #405 bumps the
   * version on every deploy.
   */
  describe('The version line (#401)', () => {
    it('renders a real, non-empty version string', async () => {
      const user = userEvent.setup();
      render(<UserMenu />);
      await user.click(screen.getByRole('button'));

      const line = await screen.findByTestId('user-menu-version');
      expect(line).toHaveTextContent(/^Version \S+$/);
    });

    it('is not the "0.0.0" the resolver degrades to when it can find nothing', async () => {
      // `resolveAppVersion()` falls back to `'0.0.0'` only when no version is
      // resolvable at all — which, in this repository, means the define is
      // wired up but reading the wrong thing.
      const user = userEvent.setup();
      render(<UserMenu />);
      await user.click(screen.getByRole('button'));

      const line = await screen.findByTestId('user-menu-version');
      expect(line.textContent).not.toBe('Version 0.0.0');
      expect(line.textContent).not.toBe('Version undefined');
      expect(line.textContent?.trim()).not.toBe('Version');
    });

    it('is shown to a viewer, who can never open /admin/settings/about', async () => {
      // The whole reason the line lives here rather than only on the About
      // page: that page is gated on `system_settings:read`, seeded Admin-only,
      // and the person most often asked "what version are you on?" is precisely
      // the one who cannot open it. The default mock in this file's outer
      // `beforeEach` is exactly that user.
      const user = userEvent.setup();
      render(<UserMenu />, { wrapperOptions: { user: mockUser } });
      await user.click(screen.getByRole('button'));

      expect(await screen.findByTestId('user-menu-version')).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('is a label, not a menu item — it is not an action and must not be one', async () => {
      const user = userEvent.setup();
      render(<UserMenu />);
      await user.click(screen.getByRole('button'));

      await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
      const line = await screen.findByTestId('user-menu-version');
      expect(line.closest('[role="menuitem"]')).toBeNull();
    });

    it('lives inside the menu, which is closed until the avatar is clicked', async () => {
      // Load-bearing for `tests/visual`: a version string inside a captured
      // region makes every future version bump a pixel-baseline failure at
      // `maxDiffPixels: 4`. See `tests/visual/support/harness.ts`.
      render(<UserMenu />);

      expect(screen.queryByTestId('user-menu-version')).not.toBeInTheDocument();
    });
  });
});
