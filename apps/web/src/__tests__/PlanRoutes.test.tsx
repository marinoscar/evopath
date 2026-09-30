/**
 * The plan routes' wiring in App.tsx (E5.6), with the pages stood in so any
 * redirect comes from the route: `programs:read` on the list, viewer and
 * history; `ai:use` plus AI on for the wizard and the run page, which
 * otherwise redirect to the list with a notice.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import App from '../App';
import { mockAiPublicConfigEnabled } from './mocks/fixtures/ai';

function PlansStandIn() {
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  return (
    <>
      <h1>Plans Page</h1>
      {notice && <p data-testid="notice">{notice}</p>}
    </>
  );
}

vi.mock('../pages/TodayPage', () => ({ default: () => <h1>Today Page</h1> }));
vi.mock('../pages/TrainPage', () => ({ default: () => <h1>Train Page</h1> }));
vi.mock('../pages/Train/PlansPage', () => ({ default: () => <PlansStandIn /> }));
vi.mock('../pages/Train/PlanWizardPage', () => ({ default: () => <h1>Wizard Page</h1> }));
vi.mock('../pages/Train/PlanRunPage', () => ({ default: () => <h1>Run Page</h1> }));
vi.mock('../pages/Train/PlanViewerPage', () => ({ default: () => <h1>Viewer Page</h1> }));
vi.mock('../pages/Train/PlanHistoryPage', () => ({ default: () => <h1>History Page</h1> }));

const API_BASE = '*/api';
const BASE = ['user_settings:read', 'programs:read', 'programs:write'];

function signInAs(permissions: string[]) {
  server.use(
    http.get(`${API_BASE}/auth/me`, () =>
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
  server.use(http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: mockAiPublicConfigEnabled })));
}

async function visit(path: string, heading: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), { timeout: 5000 });
}

describe('plan routes', () => {
  it('renders the list, viewer and history with programs:read, AI off', async () => {
    signInAs(BASE);
    await visit('/train/plans', 'Plans Page');
  });

  it('renders the viewer and history for a program id', async () => {
    signInAs(BASE);
    await visit('/train/plans/00000000-0000-4000-8000-000000000001', 'Viewer Page');
  });

  it('renders history', async () => {
    signInAs(BASE);
    await visit('/train/plans/00000000-0000-4000-8000-000000000001/history', 'History Page');
  });

  it('sends a user without programs:read back to Train', async () => {
    signInAs(['user_settings:read', 'ai:use']);
    await visit('/train/plans', 'Train Page');
  });

  it('redirects the wizard to the list with a notice while AI is off', async () => {
    signInAs([...BASE, 'ai:use']);
    await visit('/train/plans/new', 'Plans Page');
    expect(screen.getByTestId('notice')).toHaveTextContent('Creating a plan with AI is not available right now');
  });

  it('redirects the run page to the list while AI is off', async () => {
    signInAs([...BASE, 'ai:use']);
    await visit('/train/plans/runs/00000000-0000-4000-8000-000000000099', 'Plans Page');
  });

  it('redirects the wizard without ai:use even with AI on', async () => {
    aiOn();
    signInAs(BASE);
    await visit('/train/plans/new', 'Plans Page');
  });

  it('renders the wizard and the run page with ai:use and AI on', async () => {
    aiOn();
    signInAs([...BASE, 'ai:use']);
    await visit('/train/plans/new', 'Wizard Page');
  });

  it('renders the run page with ai:use and AI on (the literal segment wins over :programId)', async () => {
    aiOn();
    signInAs([...BASE, 'ai:use']);
    await visit('/train/plans/runs/00000000-0000-4000-8000-000000000099', 'Run Page');
  });
});
