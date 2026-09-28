/**
 * The avatar button in the AppBar and the menu behind it — every authenticated
 * user's one guaranteed piece of chrome, whatever their role.
 *
 * =============================================================================
 * THE VERSION LINE (issue #401, epic #397)
 * =============================================================================
 *
 * `/admin/settings/about` reports this deployment in full, and it is gated on
 * `system_settings:read` — seeded Admin-only. But the person who needs a
 * version string most often is the one who CANNOT open that page: a Viewer
 * writing a bug report, or anyone being asked "what version are you on?". So
 * the line lives here, in the one menu every role reaches.
 *
 * ⚠ IT IS `__APP_VERSION__`, BAKED INTO THIS BUNDLE AT BUILD TIME, AND IT MUST
 * NOT BECOME A FETCH. The full argument is in `build-config/app-version.ts`;
 * the short version is that this number describes the JAVASCRIPT THE BROWSER
 * IS RUNNING, not the API process. Those two differing is precisely the bug a
 * version line exists to expose — a stale cached bundle served against a
 * freshly deployed API — and a number fetched from `/api/admin/about` would be
 * rendered by the stale bundle as the NEW version, hiding exactly the mismatch
 * it was added to reveal. (It would also be unreachable for most users, since that endpoint is
 * Admin-only.)
 *
 * ⚠ IT IS INSIDE THE MENU, WHICH IS CLOSED BY DEFAULT, AND THAT PLACEMENT IS
 * LOAD-BEARING FOR `tests/visual`. A version string rendered into a region a
 * pixel baseline captures makes EVERY future version bump a baseline failure —
 * and epic #397's own #405 bumps it on every deploy. See the note in
 * `tests/visual/support/harness.ts`.
 */
import { useState } from 'react';
import {
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
} from '@mui/material';
import { Logout as LogoutIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useSettingsFeatures } from '../../hooks/useSettingsFeatures';
import { DESTINATIONS, isDestinationVisible } from '../../config/destinations';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
  const features = useSettingsFeatures();
  const navigate = useNavigate();

  const open = Boolean(anchorEl);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    handleClose();
  };

  const handleLogout = async () => {
    handleClose();
    await logout();
  };

  if (!user) return null;

  // Paths, labels, icons and gates all come from the destination table rather
  // than being spelled out again here. This menu used to hardcode `/settings`
  // and `/admin/settings` and gate the latter on `system_settings:read` while
  // the sidebar gated the same page on the `admin` ROLE — the two disagreed for
  // any Contributor granted that permission. There is now one answer.
  //
  // Home is dropped: the brand in the AppBar already routes there, and a menu
  // row duplicating on-screen chrome is the exact bloat this epic removes.
  const menuDestinations = DESTINATIONS.filter(
    (destination) =>
      destination.key !== 'home' && isDestinationVisible(destination, hasPermission, features),
  );

  const initials = user.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <>
      <IconButton
        onClick={handleOpen}
        size="small"
        aria-controls={open ? 'user-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
      >
        <Avatar
          src={user.profileImageUrl || undefined}
          alt={user.displayName || user.email}
          sx={{ width: 32, height: 32, fontSize: '0.875rem' }}
        >
          {initials}
        </Avatar>
      </IconButton>

      <Menu
        id="user-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        slotProps={{
          paper: { sx: { minWidth: 200, mt: 1 } },
        }}
      >
        {/* User Info Header */}
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {user.email}
          </Typography>
        </Box>

        <Divider />

        {/* Navigation Items */}
        {menuDestinations.map((destination) => (
          <MenuItem
            key={destination.key}
            onClick={() => handleNavigate(destination.path)}
          >
            <ListItemIcon>
              <destination.Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{destination.label}</ListItemText>
          </MenuItem>
        ))}

        <Divider />

        {/* Logout */}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>

        <Divider />

        {/* THE VERSION LINE — see this file's header.

            Deliberately NOT a `MenuItem`: it is not an action, so it must not
            be focusable, must not highlight on hover and must not be announced
            as a menu item a keyboard user can activate. A plain `Box` inside
            the menu is a label, which is what it is.

            `onClick` is stopped because the `Menu` above closes on any click
            inside it; selecting the string to copy it into a bug report would
            otherwise dismiss the menu on mouse-down-drag-up. */}
        <Box
          sx={{ px: 2, py: 1 }}
          onClick={(event) => event.stopPropagation()}
          data-testid="user-menu-version"
        >
          <Typography variant="caption" color="text.secondary">
            {`Version ${__APP_VERSION__}`}
          </Typography>
        </Box>
      </Menu>
    </>
  );
}
