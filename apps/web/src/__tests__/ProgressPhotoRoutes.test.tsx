/**
 * The E7.9 (#249) route's wiring in App.tsx: `/health/progress-photos` needs
 * `health_data:read` and otherwise redirects to Health. It is not AI-gated.
 * The pages are stood in so any redirect comes from the route.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import App from '../App';

vi.mock('../pages/TodayPage', () => ({ default: () => <h1>Today Page</h1> }));
vi.mock('../pages/HealthPage', () => ({ default: () => <h1>Health Page</h1> }));
vi.mock('../pages/ProgressPhotosPage', () => ({ default: () => <h1>Progress Photos Page</h1> }));

function signInAs(permissions: string[]) {
  server.use(
    http.get('*/api/auth/me', () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'test@example.com',
          displayName: 'Test User',
          profileImageUrl: null,
          roles: [{ name: 'viewer' }],
          permissions,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      }),
    ),
  );
}

async function visit(path: string, heading: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), { timeout: 5000 });
}

describe('progress photos route', () => {
  it('renders with health_data:read, with AI off', async () => {
    signInAs(['user_settings:read', 'health_data:read']);
    await visit('/health/progress-photos', 'Progress Photos Page');
  });

  it('keeps the ?add=1 deep link', async () => {
    signInAs(['user_settings:read', 'health_data:read', 'health_data:write']);
    await visit('/health/progress-photos?add=1', 'Progress Photos Page');
  });

  it('redirects to Health without health_data:read', async () => {
    signInAs(['user_settings:read']);
    await visit('/health/progress-photos', 'Health Page');
  });
});
