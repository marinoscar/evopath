/**
 * `/admin/settings/doctor` renders the PACKAGED Doctor page
 * (`@marinoscar/platform-web/doctor/ui`, marinoscar/EnterpriseAppBase#717)
 * inside this app's shell and theme, through the real route in `App.tsx`, the
 * real platform host (`platform/platformHost.tsx`) and the app's transport.
 *
 * The page's own behaviour (verdict, filters, rows, errors) is tested in the
 * package. What only this app can prove is the binding: the route and its
 * `system_settings:read` gate, the host the page reads, the shell around it
 * and the theme it is painted with, including this app's own `android`
 * category, which the package does not know.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { mockAdminUser, mockUser } from '../../utils/test-utils';
import App from '../../../App';

const API_BASE = '*/api';

const REPORT = {
  verdict: 'warn',
  generatedAt: new Date().toISOString(),
  durationMs: 42,
  checks: [
    {
      id: 'db.connection',
      category: 'core',
      label: 'Database connection',
      settingsPath: null,
      status: 'pass',
      detail: 'Answered in 3 ms',
      remedy: null,
      error: null,
      data: null,
      durationMs: 3,
    },
    {
      id: 'android.assetlinks',
      category: 'android',
      label: 'Android app links',
      settingsPath: '/admin/settings/android',
      status: 'warn',
      detail: 'No trusted app is configured',
      remedy: 'Add the app on Admin -> Android app.',
      error: null,
      data: null,
      durationMs: 1,
    },
  ],
};

function signInAs(user: typeof mockAdminUser) {
  server.use(http.get(`${API_BASE}/auth/me`, () => HttpResponse.json({ data: user })));
}

function serveReport() {
  const requests: URL[] = [];
  server.use(
    http.get(`${API_BASE}/admin/doctor`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({ data: REPORT, meta: {} });
    }),
  );
  return requests;
}

function visit(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('/admin/settings/doctor (the packaged Doctor page)', () => {
  it("renders the package page in the app's shell for an admin, through the app transport", async () => {
    signInAs(mockAdminUser);
    const requests = serveReport();

    visit('/admin/settings/doctor');

    const page = await screen.findByTestId('doctor-page', {}, { timeout: 5000 });
    expect(within(page).getByRole('heading', { level: 1, name: 'Doctor' })).toBeInTheDocument();
    await waitFor(() => expect(within(page).getByTestId('doctor-check-android.assetlinks')).toBeInTheDocument());
    expect(within(page).getByTestId('doctor-check-db.connection')).toBeInTheDocument();
    // The app's own category, unknown to the package, is title-cased.
    expect(within(page).getByText('Android')).toBeInTheDocument();

    // The app's transport: `/api` prefix, `{ data }` envelope unwrapped.
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0].pathname).toBe('/api/admin/doctor');

    // The shell: the page sits inside the app's layout (its `<main>` and
    // its app bar), not on a bare route.
    const main = screen.getByRole('main');
    expect(main).toContainElement(page);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it("is painted with the app's theme", async () => {
    signInAs(mockAdminUser);
    serveReport();

    visit('/admin/settings/doctor');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Doctor' }, { timeout: 5000 });
    // `theme/index.ts` keys its colour schemes on a class on <html>
    // (`colorSchemeSelector: 'class'`), set by the app's ThemeProvider.
    expect(
      document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark'),
    ).toBe(true);
    // The app's typography (`theme/index.ts`: Inter first) reaches the page.
    expect(getComputedStyle(heading).fontFamily).toContain('Inter');
  });

  it('sends a viewer without system_settings:read away before the page asks the API', async () => {
    signInAs(mockUser);
    const requests = serveReport();

    visit('/admin/settings/doctor');

    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('doctor-page')).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});
