/**
 * `UserHealthProfilePage` (issue #47, E2.1) against MSW: the page frame
 * (title, description, fetch-error alert, snackbars) around the real form and
 * the real hook, so a full save round trip is exercised end to end.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render, mockUser } from '../utils/test-utils';
import UserHealthProfilePage from '../../pages/UserHealthProfilePage';
import { HEALTH_PROFILE_CONFLICT_MESSAGE } from '../../components/settings/HealthProfileSettings';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';

describe('UserHealthProfilePage', () => {
  it('renders the title and description the registry card declares', async () => {
    render(<UserHealthProfilePage />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Health Profile' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Date of birth, sex at birth, height, units and time zone, used to interpret your measurements.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('shows an inline error and no form when the profile cannot be loaded', async () => {
    server.use(
      http.get('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 }),
      ),
    );
    render(<UserHealthProfilePage />);

    expect(await screen.findByText('Insufficient permissions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Date of birth')).not.toBeInTheDocument();
  });

  it('saves 5 ft 10 in as 1778 mm, shows the success snackbar and reloads as 5 ft 10 in', async () => {
    let body: Record<string, unknown> | null = null;
    let ifMatch: string | null = null;
    server.use(
      http.put('*/api/health-profile', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({
          data: { ...body, version: 1, updatedAt: '2026-09-29T00:00:00.000Z' },
        });
      }),
    );
    const user = userEvent.setup();
    render(<UserHealthProfilePage />);

    await user.click(await screen.findByRole('button', { name: 'Imperial' }));
    await user.type(screen.getByRole('textbox', { name: 'Height (feet)' }), '5');
    await user.type(screen.getByRole('textbox', { name: 'Height (inches)' }), '10');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Health profile saved')).toBeInTheDocument();
    expect(ifMatch).toBe('0');
    expect(body).toMatchObject({ heightMm: 1778, unitSystem: 'imperial' });
    expect(screen.getByRole('textbox', { name: 'Height (feet)' })).toHaveValue('5');
    expect(screen.getByRole('textbox', { name: 'Height (inches)' })).toHaveValue('10');
  });

  it('sends the lab units preference with If-Match (#234)', async () => {
    let body: Record<string, unknown> | null = null;
    let ifMatch: string | null = null;
    server.use(
      http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
      http.put('*/api/health-profile', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: { ...body, version: 4, updatedAt: '2026-10-01T00:00:00.000Z' } });
      }),
    );
    const user = userEvent.setup();
    render(<UserHealthProfilePage />);

    await user.click(await screen.findByRole('radio', { name: 'SI (mmol/L)' }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Health profile saved')).toBeInTheDocument();
    expect(ifMatch).toBe(String(mockHealthProfileSaved.version));
    expect(body).toMatchObject({ labUnits: 'si' });
    expect(screen.getByRole('radio', { name: 'SI (mmol/L)' })).toBeChecked();
  });

  it('a stale save shows the conflict message; Reload refetches', async () => {
    let gets = 0;
    server.use(
      http.get('*/api/health-profile', () => {
        gets += 1;
        return HttpResponse.json({
          data: gets === 1 ? mockHealthProfileSaved : { ...mockHealthProfileSaved, version: 4 },
        });
      }),
      http.put('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Version mismatch' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    render(<UserHealthProfilePage />);

    await user.click(await screen.findByRole('button', { name: /save/i }));
    expect(await screen.findByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(gets).toBe(2));
    await waitFor(() =>
      expect(screen.queryByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).not.toBeInTheDocument(),
    );
  });

  it('reports any other save failure in the error snackbar', async () => {
    server.use(
      http.put('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Validation failed' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<UserHealthProfilePage />);

    await user.click(await screen.findByRole('button', { name: /save/i }));
    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
  });

  it('disables the form for a user holding health_data:read but not health_data:write', async () => {
    render(<UserHealthProfilePage />, {
      wrapperOptions: {
        user: { ...mockUser, permissions: ['user_settings:read', 'health_data:read'] },
      },
    });

    expect(await screen.findByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByLabelText('Date of birth')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Bio' })).toBeDisabled();
  });
});
