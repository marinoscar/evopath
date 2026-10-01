/**
 * "Export health data" on the Health page (issue #191, H7): reachable with
 * `health_data:read` alone and with AI off, absent without the read grant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import HealthPage from '../../pages/HealthPage';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';

const readOnly = {
  ...mockUser,
  permissions: mockUser.permissions.filter((p) => p !== 'health_data:write' && p !== 'ai:use'),
};

describe('HealthPage export action', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('a reader with AI off opens the export dialog from the header', async () => {
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: readOnly, aiEnabled: false } });

    await user.click(await screen.findByRole('button', { name: 'Export health data' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export health data' });
    expect(await within(dialog).findByText(/No exports yet/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export health data' })).not.toBeInTheDocument());
  });

  it('is absent without health_data:read', () => {
    render(<HealthPage />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['user_settings:read'] } },
    });
    expect(screen.queryByRole('button', { name: 'Export health data' })).not.toBeInTheDocument();
  });
});
