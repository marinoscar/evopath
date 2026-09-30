/**
 * The E6.1 route's wiring in App.tsx: `/train/adapt/:adaptationId` needs
 * `ai:use` and AI being on, and otherwise redirects to Train. The pages are
 * stood in so any redirect comes from the route.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import App from '../App';
import { mockAiPublicConfigEnabled } from './mocks/fixtures/ai';

vi.mock('../pages/TodayPage', () => ({ default: () => <h1>Today Page</h1> }));
vi.mock('../pages/TrainPage', () => ({ default: () => <h1>Train Page</h1> }));
vi.mock('../pages/AdaptationReviewPage', () => ({ default: () => <h1>Adaptation Page</h1> }));

const PATH = '/train/adapt/00000000-0000-4000-8000-e00000000001';

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

function aiOn() {
  server.use(http.get('*/api/ai/config', () => HttpResponse.json({ data: mockAiPublicConfigEnabled })));
}

async function visit(heading: string) {
  render(
    <MemoryRouter initialEntries={[PATH]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), { timeout: 5000 });
}

describe('adaptation route', () => {
  it('renders with ai:use and AI on', async () => {
    signInAs(['user_settings:read', 'ai:use']);
    aiOn();
    await visit('Adaptation Page');
  });

  it('redirects to Train without ai:use', async () => {
    signInAs(['user_settings:read']);
    aiOn();
    await visit('Train Page');
  });

  it('redirects to Train while AI is off', async () => {
    signInAs(['user_settings:read', 'ai:use']);
    await visit('Train Page');
  });
});
