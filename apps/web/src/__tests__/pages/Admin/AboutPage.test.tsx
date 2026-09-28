/**
 * Admin → Operations → About (`/admin/settings/about`), issue #401, epic #397.
 *
 * The page has THREE render states and the suite is organised around them,
 * because the third is the one an implementation loses:
 *
 *   1. `ok` — the facts.
 *   2. `absent` / `invalid` — no usable record. What is asserted here is as
 *      much about what the copy must NOT say as about what it must: the API
 *      deliberately asserts nothing about how the instance was deployed (see
 *      `apps/api/src/about/dto/about-response.dto.ts`), and a page that says
 *      "this instance was not deployed with the CLI" turns a truthful 200 into
 *      a false statement. There is a test below that fails if that sentence,
 *      or anything meaning it, appears.
 *   3. `ok` WITH `run.outcome: 'failure'` — a complete record describing a run
 *      that failed partway. Every fact must still render. The assertions are
 *      deliberately positive about the FACTS and not only about the warning:
 *      an implementation that collapsed this into state 2 would still pass a
 *      test that only checked for the warning text.
 *
 * Plus the two things that are facts rather than errors: a `null` database, and
 * the API's own version, which survives every other failure on the page.
 *
 * msw rather than a mocked hook, for the reason the Maintenance suite gives:
 * mocking the hook would hide the request shape, and the request shape is half
 * of what this page is. `usePermissions` is left real and driven through the
 * auth fixture, because the redirect is one of the behaviours under test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import AboutPage from '../../../pages/Admin/AboutPage';
import { api } from '../../../services/api';
import type { AboutResponse } from '../../../types';
import { setViewportWidth } from '../../setup';

/** A complete, successful document — the baseline every state overrides. */
function aboutResponse(overrides: Partial<AboutResponse> = {}): AboutResponse {
  const base: AboutResponse = {
    api: { version: '2.4.1' },
    deployInfoStatus: 'ok',
    deployInfoPath: '/srv/app/deploy/info.json',
    deployInfoError: null,
    app: {
      name: 'EnterpriseAppBase',
      version: '2.4.1',
      commitSha: '4f21ab9c33de7715b0a1d2e3f4a5b6c7d8e9f001',
      ref: 'main',
    },
    installedAt: '2026-01-04T09:12:00.000Z',
    updatedAt: '2026-08-30T18:40:00.000Z',
    deployedBy: { cli: 'appctl', version: '1.9.0' },
    domain: 'app.example.com',
    remote: { commitsBehind: 3, checkedAt: '2026-08-30T18:39:00.000Z' },
    run: { completed: ['pull', 'build', 'migrate', 'restart'], failedStep: null, outcome: 'success' },
    database: { status: 'up', responseTime: '4ms' },
    databaseError: null,
  };
  return { ...base, ...overrides };
}

function serveAbout(value: AboutResponse) {
  server.use(http.get('*/api/admin/about', () => HttpResponse.json({ data: value })));
}

function serveFailure(status: number, message: string) {
  server.use(
    http.get('*/api/admin/about', () =>
      HttpResponse.json({ message, code: 'FORBIDDEN' }, { status }),
    ),
  );
}

/** The whole rendered page as text — used by the "asserts no negative" test. */
function pageText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  api.setAccessToken(null);
});

describe('AboutPage — state 1: a document was read and the run succeeded', () => {
  it('names the page identically to its registry card', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();
    expect(
      screen.getByText(/the version running, the commit it was built from/i),
    ).toBeInTheDocument();
  });

  it('shows the facts an operator came for', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const facts = await screen.findByTestId('about-deployment-facts');
    expect(within(facts).getByText('EnterpriseAppBase')).toBeInTheDocument();
    expect(
      within(facts).getByText('4f21ab9c33de7715b0a1d2e3f4a5b6c7d8e9f001'),
    ).toBeInTheDocument();
    expect(within(facts).getByText('main')).toBeInTheDocument();
    expect(within(facts).getByText('app.example.com')).toBeInTheDocument();
    expect(within(facts).getByText('appctl 1.9.0')).toBeInTheDocument();
    // Shown on `ok` too, not only when the record is missing: comparing two
    // instances means knowing which file each answered from.
    expect(within(facts).getByText('/srv/app/deploy/info.json')).toBeInTheDocument();
  });

  it('renders a fact the document did not carry as "Not recorded", never as blank', async () => {
    serveAbout(
      aboutResponse({
        app: { name: 'EnterpriseAppBase', version: '2.4.1', commitSha: null, ref: null },
        domain: null,
      }),
    );
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const facts = await screen.findByTestId('about-deployment-facts');
    expect(within(facts).getAllByText('Not recorded').length).toBeGreaterThanOrEqual(3);
  });

  it('lists the steps the run completed and marks the outcome a success', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const steps = await screen.findByTestId('about-run-steps');
    for (const step of ['pull', 'build', 'migrate', 'restart']) {
      expect(within(steps).getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.queryByTestId('about-run-failed')).not.toBeInTheDocument();
  });

  it('carries the remote count together with when it was checked, and says it is not refreshed', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const remote = await screen.findByTestId('about-remote-facts');
    expect(within(remote).getByText('3')).toBeInTheDocument();
    // The caveat is not decoration: "3 commits behind" is unreadable without
    // "as of when", and this page performs no network I/O to refresh it.
    expect(screen.getByText(/never refreshed since/i)).toBeInTheDocument();
  });

  it('shows no "no record" branch at all', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByTestId('about-deployment-facts');
    expect(screen.queryByTestId('about-no-record')).not.toBeInTheDocument();
  });
});

describe('AboutPage — state 2: no usable deployment record', () => {
  it('says a record was not found, and shows the exact path the API looked at', async () => {
    serveAbout(
      aboutResponse({
        deployInfoStatus: 'absent',
        deployInfoPath: '/srv/app/deploy/info.json',
        app: null,
        installedAt: null,
        updatedAt: null,
        deployedBy: null,
        domain: null,
        remote: null,
        run: null,
      }),
    );
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('about-no-record');
    expect(within(alert).getByText(/No deployment record was found/i)).toBeInTheDocument();
    expect(screen.getByTestId('about-deploy-info-path')).toHaveTextContent(
      '/srv/app/deploy/info.json',
    );
  });

  it('⚠ asserts NOTHING about how this instance was deployed', async () => {
    // The point of this test, and the reason it is written against the whole
    // page rather than one element: the API's DTO refuses to carry a field
    // meaning "not deployed with the CLI" because that claim is FALSE whenever
    // the path is mis-set, the bind mount did not attach, or a run stopped
    // early. The web half of that contract is that no such sentence gets
    // invented here either.
    serveAbout(aboutResponse({ deployInfoStatus: 'absent', app: null, run: null }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByTestId('about-no-record');
    const text = pageText();
    expect(text).not.toMatch(/was not deployed/i);
    expect(text).not.toMatch(/not deployed (with|using|by)/i);
    expect(text).not.toMatch(/never deployed/i);
    expect(text).not.toMatch(/deployed manually/i);
  });

  it('offers the ordinary explanations without picking one', async () => {
    serveAbout(aboutResponse({ deployInfoStatus: 'absent', app: null, run: null }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('about-no-record');
    expect(alert).toHaveTextContent(/written somewhere else/i);
    expect(alert).toHaveTextContent(/mount that did not attach/i);
    expect(alert).toHaveTextContent(/stopped before/i);
  });

  it('reports why an invalid record could not be used, and still shows the path', async () => {
    serveAbout(
      aboutResponse({
        deployInfoStatus: 'invalid',
        deployInfoError: 'Unexpected token } in JSON at position 214',
        app: null,
        run: null,
        remote: null,
      }),
    );
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('about-no-record');
    expect(within(alert).getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByTestId('about-deploy-info-error')).toHaveTextContent(
      'Unexpected token } in JSON at position 214',
    );
    expect(screen.getByTestId('about-deploy-info-path')).toHaveTextContent(
      '/srv/app/deploy/info.json',
    );
  });

  it('still reports the API process version, which no missing file can take away', async () => {
    serveAbout(aboutResponse({ deployInfoStatus: 'absent', app: null, run: null }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const apiFacts = await screen.findByTestId('about-api-facts');
    expect(within(apiFacts).getByText('2.4.1')).toBeInTheDocument();
  });

  it('renders no deployment-facts block, because there are none to render', async () => {
    serveAbout(aboutResponse({ deployInfoStatus: 'absent', app: null, run: null }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByTestId('about-no-record');
    expect(screen.queryByTestId('about-deployment-facts')).not.toBeInTheDocument();
  });
});

describe('AboutPage — state 3: a complete record whose deploy run failed', () => {
  const failedRun = aboutResponse({
    run: {
      completed: ['pull', 'build'],
      failedStep: 'migrate',
      outcome: 'failure',
    },
  });

  it('warns, and names the step that failed', async () => {
    serveAbout(failedRun);
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const warning = await screen.findByTestId('about-run-failed');
    expect(warning).toHaveTextContent(/deploy run that wrote this record failed/i);
    expect(within(warning).getByText('migrate')).toBeInTheDocument();
  });

  it('⚠ renders EVERY fact as normal — the warning is additive, never a replacement', async () => {
    // This is the assertion the implementation loses. A run that got far enough
    // to write the document DID deploy something: there is a real commit on
    // this box, and hiding it behind the warning throws away exactly what the
    // operator came for.
    serveAbout(failedRun);
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const facts = await screen.findByTestId('about-deployment-facts');
    expect(
      within(facts).getByText('4f21ab9c33de7715b0a1d2e3f4a5b6c7d8e9f001'),
    ).toBeInTheDocument();
    expect(within(facts).getByText('main')).toBeInTheDocument();
    expect(within(facts).getByText('app.example.com')).toBeInTheDocument();
    expect(within(facts).getByText('appctl 1.9.0')).toBeInTheDocument();
  });

  it('is NOT collapsed into the "no record" state', async () => {
    serveAbout(failedRun);
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByTestId('about-run-failed');
    expect(screen.queryByTestId('about-no-record')).not.toBeInTheDocument();
  });

  it('keeps the steps that really ran, and marks the outcome failed', async () => {
    serveAbout(failedRun);
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const steps = await screen.findByTestId('about-run-steps');
    expect(within(steps).getByText('pull')).toBeInTheDocument();
    expect(within(steps).getByText('build')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('copes with a failure that did not record which step it stopped at', async () => {
    serveAbout(
      aboutResponse({
        run: { completed: ['pull'], failedStep: null, outcome: 'failure' },
      }),
    );
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const warning = await screen.findByTestId('about-run-failed');
    expect(warning).toHaveTextContent(/did not record which step/i);
    // And the facts are still there.
    expect(await screen.findByTestId('about-deployment-facts')).toBeInTheDocument();
  });
});

describe('AboutPage — the database is a fact, not a page error', () => {
  it('reports a healthy database inline', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const db = await screen.findByTestId('about-database-facts');
    expect(within(db).getByText('up')).toBeInTheDocument();
    expect(within(db).getByText('4ms')).toBeInTheDocument();
  });

  it('renders a null database as its own warning, never as the page-level error', async () => {
    serveAbout(
      aboutResponse({
        database: null,
        databaseError: 'connect ECONNREFUSED 10.0.0.4:5432',
      }),
    );
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const dbError = await screen.findByTestId('about-database-error');
    expect(dbError).toHaveTextContent('connect ECONNREFUSED 10.0.0.4:5432');
    // The whole point: the endpoint answered 200, so this is NOT a failed
    // request, and the rest of the page is still there.
    expect(screen.queryByTestId('about-request-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('about-deployment-facts')).toBeInTheDocument();
  });

  it('still renders something useful when the probe failed and gave no reason', async () => {
    serveAbout(aboutResponse({ database: null, databaseError: null }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const dbError = await screen.findByTestId('about-database-error');
    expect(dbError).toHaveTextContent(/did not answer/i);
  });
});

describe('AboutPage — the request itself failing', () => {
  it('surfaces a 403 as the page-level error, with a retry', async () => {
    serveFailure(403, 'Insufficient permissions');
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('about-request-error');
    expect(alert).toHaveTextContent('Insufficient permissions');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers when the retry succeeds', async () => {
    const user = userEvent.setup();
    serveFailure(500, 'Something went wrong');
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const alert = await screen.findByTestId('about-request-error');
    serveAbout(aboutResponse());
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('about-deployment-facts')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('about-request-error')).not.toBeInTheDocument(),
    );
  });

  it('re-reads on demand, picking up a deployment made since the page was opened', async () => {
    const user = userEvent.setup();
    serveAbout(aboutResponse());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByTestId('about-deployment-facts');
    serveAbout(
      aboutResponse({
        app: { name: 'EnterpriseAppBase', version: '2.5.0', commitSha: 'aaaa111', ref: 'main' },
      }),
    );
    await user.click(screen.getByRole('button', { name: /re-read/i }));

    expect(await screen.findByText('aaaa111')).toBeInTheDocument();
  });
});

describe('AboutPage — the permission gate', () => {
  it('redirects a user without system_settings:read, rather than rendering the page', async () => {
    serveAbout(aboutResponse());
    // A viewer: `user_settings:*` only. `App.tsx` wraps the route in
    // `RequirePermission` with the same string; this is the page's own
    // defence-in-depth check, which must hold on its own.
    render(<AboutPage />, { wrapperOptions: { user: mockUser } });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'About' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('about-deployment-facts')).not.toBeInTheDocument();
  });

  it('renders for a read-only admin, because the page has no write side to gate', async () => {
    serveAbout(aboutResponse());
    render(<AboutPage />, {
      wrapperOptions: { user: { ...mockAdminUser, permissions: ['system_settings:read'] } },
    });

    expect(await screen.findByTestId('about-deployment-facts')).toBeInTheDocument();
  });
});

/**
 * Issue #392 — deployment detail delivered on this page rather than a parallel
 * "Deployment" page. Every field is optional AND nullable (an older API or an
 * older deploy record), so each block is asserted twice: populated, and absent.
 */
describe('AboutPage — deployment detail (#392)', () => {
  const DAY = 86_400_000;
  const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

  function full(overrides: Partial<AboutResponse> = {}): AboutResponse {
    return aboutResponse({
      lastCommand: 'update',
      bindPort: 8080,
      proxy: { mode: 'host', container: null, certificateExpiresAt: inDays(80) },
      host: {
        hostname: 'vps-prod-01',
        os: 'Ubuntu 24.04.1 LTS',
        kernel: '6.8.0-45-generic',
        arch: 'x64',
        cpus: 4,
        memoryBytes: 8 * 1024 ** 3,
        dockerVersion: '27.3.1',
        composeVersion: '2.29.7',
        capturedAt: '2026-08-30T18:40:00.000Z',
      },
      history: [
        {
          at: '2026-08-30T18:40:00.000Z',
          command: 'update',
          commitSha: '4f21ab9c33de7715b0a1d2e3f4a5b6c7d8e9f001',
          previousCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          ref: 'main',
          durationMs: 95_000,
          cliVersion: '1.9.0',
          outcome: 'success',
        },
        {
          at: '2026-01-04T09:12:00.000Z',
          command: 'install',
          commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          previousCommitSha: null,
          ref: 'v2.0.0',
          durationMs: null,
          cliVersion: '1.2.0',
          outcome: 'success',
        },
      ],
      runtime: {
        processStartedAt: '2026-08-30T18:41:00.000Z',
        nodeVersion: 'v20.17.0',
        environment: 'production',
      },
      ...overrides,
    });
  }

  it('shows the last command, bind port and proxy among the deployment facts', async () => {
    serveAbout(full());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const facts = await screen.findByTestId('about-deployment-facts');
    expect(within(facts).getByText('Update')).toBeInTheDocument();
    expect(within(facts).getByText('8080')).toBeInTheDocument();
    expect(within(facts).getByText('Host proxy')).toBeInTheDocument();
  });

  it('labels an install as Install', async () => {
    serveAbout(full({ lastCommand: 'install' }));
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const facts = await screen.findByTestId('about-deployment-facts');
    expect(within(facts).getByText('Install')).toBeInTheDocument();
  });

  it('renders the host panel with formatted memory', async () => {
    serveAbout(full());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const host = await screen.findByTestId('about-host-facts');
    expect(within(host).getByText('vps-prod-01')).toBeInTheDocument();
    expect(within(host).getByText('Ubuntu 24.04.1 LTS')).toBeInTheDocument();
    expect(within(host).getByText('6.8.0-45-generic')).toBeInTheDocument();
    expect(within(host).getByText('x64')).toBeInTheDocument();
    expect(within(host).getByText('4')).toBeInTheDocument();
    expect(within(host).getByText('8 GiB')).toBeInTheDocument();
    expect(within(host).getByText('27.3.1')).toBeInTheDocument();
    expect(within(host).getByText('2.29.7')).toBeInTheDocument();
    expect(screen.queryByTestId('about-host-not-recorded')).not.toBeInTheDocument();
  });

  it('renders the runtime facts inside the API process panel', async () => {
    serveAbout(full());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const apiFacts = await screen.findByTestId('about-api-facts');
    expect(within(apiFacts).getByText('v20.17.0')).toBeInTheDocument();
    expect(within(apiFacts).getByText('production')).toBeInTheDocument();
    expect(within(apiFacts).getByText('Process started')).toBeInTheDocument();
  });

  it('lists every history entry as a table row, previous → new commit', async () => {
    serveAbout(full());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const table = await screen.findByTestId('about-history-table');
    const rows = within(table).getAllByTestId('about-history-row');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByText('Update')).toBeInTheDocument();
    expect(within(rows[0]).getByText('a1b2c3d')).toBeInTheDocument();
    expect(within(rows[0]).getByText('4f21ab9')).toBeInTheDocument();
    expect(within(rows[0]).getByText('main')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1m 35s')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1.9.0')).toBeInTheDocument();

    // A first install has no previous commit and an unmeasured duration.
    expect(within(rows[1]).getByText('Install')).toBeInTheDocument();
    expect(within(rows[1]).getByText('a1b2c3d')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('→')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('v2.0.0')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Not recorded')).toBeInTheDocument();
  });

  it('collapses the history into stacked cards on a phone, with no table mounted', async () => {
    setViewportWidth(390);
    serveAbout(full());
    render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

    const list = await screen.findByTestId('about-history-list');
    expect(within(list).getAllByTestId('about-history-item')).toHaveLength(2);
    expect(screen.queryByTestId('about-history-table')).not.toBeInTheDocument();
  });

  describe('certificate expiry', () => {
    it('renders a comfortable expiry in the normal colour, relative and absolute', async () => {
      serveAbout(full());
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      const cert = await screen.findByTestId('about-certificate-expiry');
      expect(cert).toHaveAttribute('data-state', 'ok');
      expect(cert).toHaveTextContent(/Expires in (79|80) days/);
      expect(cert).toHaveTextContent('(');
    });

    it('warns when fewer than 21 days remain', async () => {
      serveAbout(full({ proxy: { mode: 'host', container: null, certificateExpiresAt: inDays(10) } }));
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      const cert = await screen.findByTestId('about-certificate-expiry');
      expect(cert).toHaveAttribute('data-state', 'expiring');
      expect(cert).toHaveStyle({ color: 'rgb(237, 108, 2)' });
    });

    it('marks an expired certificate as an error', async () => {
      serveAbout(full({ proxy: { mode: 'host', container: null, certificateExpiresAt: inDays(-3) } }));
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      const cert = await screen.findByTestId('about-certificate-expiry');
      expect(cert).toHaveAttribute('data-state', 'expired');
      expect(cert).toHaveTextContent(/Expired 3 days ago/);
      expect(cert).toHaveStyle({ color: 'rgb(211, 47, 47)' });
    });
  });

  describe('absent or null #392 fields', () => {
    it('renders exactly as before when the response predates #392', async () => {
      // `aboutResponse()` carries none of the new keys at all.
      serveAbout(aboutResponse());
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      const facts = await screen.findByTestId('about-deployment-facts');
      // Last command, bind port, proxy and certificate.
      expect(within(facts).getAllByText('Not recorded')).toHaveLength(4);
      expect(screen.queryByTestId('about-certificate-expiry')).not.toBeInTheDocument();
      expect(screen.getByTestId('about-host-not-recorded')).toBeInTheDocument();
      expect(screen.getByTestId('about-history-empty')).toBeInTheDocument();
      const apiFacts = screen.getByTestId('about-api-facts');
      expect(within(apiFacts).getAllByText('Not recorded')).toHaveLength(3);
    });

    it('treats explicit nulls the same as absent keys', async () => {
      serveAbout(
        aboutResponse({
          lastCommand: null,
          bindPort: null,
          proxy: null,
          host: null,
          history: [],
          runtime: null,
        }),
      );
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      await screen.findByTestId('about-deployment-facts');
      expect(screen.getByTestId('about-host-not-recorded')).toBeInTheDocument();
      expect(screen.getByTestId('about-history-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('about-history-table')).not.toBeInTheDocument();
    });

    it('renders the history fallback for history: null on a readable record', async () => {
      serveAbout(full({ history: null }));
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(await screen.findByTestId('about-history-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('about-history-table')).not.toBeInTheDocument();
      // The rest of the #392 detail is unaffected.
      expect(screen.getByTestId('about-host-facts')).toBeInTheDocument();
    });

    it('renders null host sub-fields as "Not recorded"', async () => {
      serveAbout(
        full({
          host: {
            hostname: 'vps-prod-01',
            os: null,
            kernel: null,
            arch: null,
            cpus: null,
            memoryBytes: null,
            dockerVersion: null,
            composeVersion: null,
            capturedAt: null,
          },
        }),
      );
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      const host = await screen.findByTestId('about-host-facts');
      expect(within(host).getAllByText('Not recorded')).toHaveLength(8);
    });

    it('shows no host or history panel at all when there is no record', async () => {
      serveAbout(
        full({ deployInfoStatus: 'absent', app: null, run: null, remote: null }),
      );
      render(<AboutPage />, { wrapperOptions: { user: mockAdminUser } });

      await screen.findByTestId('about-no-record');
      expect(screen.queryByTestId('about-host-facts')).not.toBeInTheDocument();
      expect(screen.queryByTestId('about-host-not-recorded')).not.toBeInTheDocument();
      expect(screen.queryByTestId('about-history-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('about-history-empty')).not.toBeInTheDocument();
      // The runtime is live, not from the record, so it survives.
      expect(within(screen.getByTestId('about-api-facts')).getByText('v20.17.0')).toBeInTheDocument();
    });
  });
});
