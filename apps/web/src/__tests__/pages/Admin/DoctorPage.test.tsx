/**
 * Admin → Observability → Doctor (`/admin/settings/doctor`), issue #634.
 *
 * msw rather than a mocked hook, so the request shape (`refresh=true` on a
 * rerun) is under test too. `usePermissions` stays real, driven through the
 * auth fixture.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import DoctorPage, { categoryLabel } from '../../../pages/Admin/DoctorPage';
import { api } from '../../../services/api';
import type { DoctorCheckReport, DoctorReport } from '../../../services/doctor';
import { setViewportWidth } from '../../setup';

function check(overrides: Partial<DoctorCheckReport> & Pick<DoctorCheckReport, 'id' | 'category'>): DoctorCheckReport {
  return {
    label: overrides.id,
    settingsPath: null,
    status: 'pass',
    detail: `${overrides.id} is fine`,
    remedy: null,
    error: null,
    data: null,
    durationMs: 5,
    ...overrides,
  };
}

const MIXED: DoctorReport = {
  verdict: 'fail',
  generatedAt: new Date().toISOString(),
  durationMs: 1840,
  checks: [
    // Deliberately out of display order: the page sorts categories.
    check({ id: 'telemetry.capture', category: 'telemetry', label: 'Telemetry capture', status: 'skip', detail: 'Telemetry is switched off' }),
    check({ id: 'core.database', category: 'core', label: 'Database', detail: 'PostgreSQL answered' }),
    check({
      id: 'storage.bucket',
      category: 'storage',
      label: 'Bucket reachable',
      status: 'fail',
      detail: 'HeadBucket was refused',
      remedy: 'Widen the credential policy to allow s3:ListBucket.',
      error: 'AccessDenied: Access Denied (bucket: uploads)',
      settingsPath: '/admin/settings/storage',
    }),
    check({
      id: 'email.smtp',
      category: 'email',
      label: 'SMTP login',
      status: 'warn',
      detail: 'No SMTP server is configured',
      remedy: 'Configure SMTP to send email.',
      settingsPath: '/admin/settings/email',
    }),
    check({ id: 'fork.widgets', category: 'fork_widgets', label: 'Widget service', detail: 'Widgets answered' }),
  ],
};

function serveReport(report: DoctorReport) {
  server.use(http.get('*/api/admin/doctor', () => HttpResponse.json({ data: report })));
}

beforeEach(() => {
  api.setAccessToken(null);
});

describe('DoctorPage', () => {
  it('names the page identically to its registry card and shows a skeleton while loading', async () => {
    server.use(
      http.get('*/api/admin/doctor', async () => {
        await delay('infinite');
        return HttpResponse.json({ data: MIXED });
      }),
    );
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(screen.getByRole('heading', { level: 1, name: 'Doctor' })).toBeInTheDocument();
    expect(screen.getByText(/connectivity and health of every capability/i)).toBeInTheDocument();
    expect(screen.getByTestId('doctor-loading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /running checks/i })).toBeDisabled();
  });

  it('shows a failed request as an error with a working retry', async () => {
    server.use(
      http.get('*/api/admin/doctor', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })),
    );
    const user = userEvent.setup();
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('doctor-request-error');
    expect(alert).toHaveTextContent('Boom');

    serveReport(MIXED);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('doctor-verdict')).toBeInTheDocument();
    expect(screen.queryByTestId('doctor-request-error')).not.toBeInTheDocument();
  });

  it('renders a mixed report: verdict, counts, ordered sections, remedy, error and settings link', async () => {
    serveReport(MIXED);
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

    const verdict = await screen.findByTestId('doctor-verdict');
    expect(verdict).toHaveTextContent('2 problems need attention');
    expect(verdict).toHaveAttribute('aria-live', 'polite');

    expect(screen.getByTestId('doctor-count-pass')).toHaveTextContent('Pass: 2');
    expect(screen.getByTestId('doctor-count-warn')).toHaveTextContent('Warning: 1');
    expect(screen.getByTestId('doctor-count-fail')).toHaveTextContent('Fail: 1');
    expect(screen.getByTestId('doctor-count-skip')).toHaveTextContent('Skipped: 1');
    expect(screen.getByTestId('doctor-generated')).toHaveTextContent('1.8 s');

    // Known categories in display order, then the fork's, title-cased.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Core', 'Object storage', 'Email', 'Telemetry', 'Fork Widgets']);

    // Categories with a problem start expanded; the others start collapsed.
    const storageSummary = within(screen.getByTestId('doctor-category-storage')).getAllByRole('button')[0];
    expect(storageSummary).toHaveAttribute('aria-expanded', 'true');
    const coreSummary = within(screen.getByTestId('doctor-category-core')).getAllByRole('button')[0];
    expect(coreSummary).toHaveAttribute('aria-expanded', 'false');

    const bucket = screen.getByTestId('doctor-check-storage.bucket');
    expect(within(bucket).getByText('Bucket reachable')).toBeInTheDocument();
    expect(within(bucket).getByTestId('doctor-check-status-storage.bucket')).toHaveTextContent('Fail');
    expect(within(bucket).getByTestId('doctor-check-remedy-storage.bucket')).toHaveTextContent(
      'Widen the credential policy',
    );
    expect(within(bucket).getByTestId('doctor-check-error-storage.bucket')).toHaveTextContent(
      'AccessDenied: Access Denied (bucket: uploads)',
    );
    expect(within(bucket).getByRole('link', { name: /open settings for bucket reachable/i })).toHaveAttribute(
      'href',
      '/admin/settings/storage',
    );
  });

  it('says all checks passed when every check passes', async () => {
    serveReport({
      ...MIXED,
      verdict: 'pass',
      checks: [check({ id: 'core.database', category: 'core' })],
    });
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByTestId('doctor-verdict')).toHaveTextContent('All checks passed');
  });

  it('filters to warnings and failures with "Problems only"', async () => {
    serveReport(MIXED);
    const user = userEvent.setup();
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByTestId('doctor-verdict');

    await user.click(screen.getByRole('switch', { name: 'Problems only' }));

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Object storage', 'Email']);
    expect(screen.queryByTestId('doctor-check-core.database')).not.toBeInTheDocument();
    expect(screen.queryByTestId('doctor-check-telemetry.capture')).not.toBeInTheDocument();
    expect(screen.getByTestId('doctor-check-storage.bucket')).toBeInTheDocument();
    expect(screen.getByTestId('doctor-check-email.smtp')).toBeInTheDocument();
    // The summary counts still describe the whole run.
    expect(screen.getByTestId('doctor-count-pass')).toHaveTextContent('Pass: 2');
  });

  it('sends refresh=true when "Run again" is clicked', async () => {
    const urls: URL[] = [];
    server.use(
      http.get('*/api/admin/doctor', ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json({ data: MIXED });
      }),
    );
    const user = userEvent.setup();
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByTestId('doctor-verdict');
    expect(urls[0].searchParams.get('refresh')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Run again' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1].searchParams.get('refresh')).toBe('true');
  });

  it('renders the whole report at phone width', async () => {
    setViewportWidth(375);
    serveReport(MIXED);
    render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByTestId('doctor-verdict')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Problems only' })).toBeInTheDocument();
    expect(screen.getByTestId('doctor-check-storage.bucket')).toBeInTheDocument();
  });

  it('redirects a user without system_settings:read', async () => {
    serveReport(MIXED);
    render(<DoctorPage />, { wrapperOptions: { user: mockUser } });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Doctor' })).not.toBeInTheDocument(),
    );
  });
});

describe('categoryLabel', () => {
  it('labels known categories and title-cases unknown ones', () => {
    expect(categoryLabel('push')).toBe('Web Push');
    expect(categoryLabel('backup')).toBe('Database backup');
    expect(categoryLabel('fork_widgets')).toBe('Fork Widgets');
    expect(categoryLabel('billing')).toBe('Billing');
  });
});
