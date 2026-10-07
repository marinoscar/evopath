/**
 * `/admin/settings/telemetry` (issue #537, epic #528).
 *
 * Wire-level: the real hooks run against MSW, so these assertions cover what
 * the page SENDS (the PUT body and its `If-Match`) as well as what it renders.
 */
import { describe, it, expect } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { setViewportWidth } from '../../setup';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import {
  mockTelemetryAdminConfig,
  mockTelemetryConnectionAutomaticEnvironment,
  mockTelemetryConnectionAutomaticProblem,
  mockTelemetryConnectionAutomaticStored,
  mockTelemetryConnectionCustomStored,
  mockTelemetryConnectionNone,
  mockTelemetryConnectionStored,
  mockTelemetryConnectionTestResult,
  mockTelemetryStackMissing,
  mockTelemetryStackRunning,
  mockTelemetryStatusUnconfigured,
} from '../../mocks/fixtures/telemetry';
import type {
  TelemetryConnection,
  TelemetryConnectionCustomInput,
  TelemetryConnectionInput,
  TelemetryPublicConfig,
  TelemetrySettingsUpdate,
} from '@marinoscar/platform-web/telemetry/headless';
import TelemetrySettingsPage from '@marinoscar/platform-web/telemetry/ui/settings-page';

const API_BASE = '*/api';

const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((permission) => permission !== 'telemetry:write'),
};

function renderPage(
  options: { user?: MockUser; aiEnabled?: boolean; telemetryEnabled?: boolean | TelemetryPublicConfig } = {},
) {
  return render(<TelemetrySettingsPage />, {
    wrapperOptions: {
      user: options.user ?? mockAdminUser,
      aiEnabled: options.aiEnabled ?? true,
      telemetryEnabled: options.telemetryEnabled ?? true,
      route: '/admin/settings/telemetry',
    },
  });
}

function capturePut() {
  const calls: { body: TelemetrySettingsUpdate; ifMatch: string | null }[] = [];
  server.use(
    http.put(`${API_BASE}/admin/telemetry/config`, async ({ request }) => {
      const body = (await request.json()) as TelemetrySettingsUpdate;
      calls.push({ body, ifMatch: request.headers.get('If-Match') });
      const instanceId =
        body.instanceId === undefined ? mockTelemetryAdminConfig.instanceId : body.instanceId;
      return HttpResponse.json({
        data: {
          ...mockTelemetryAdminConfig,
          ...body,
          instanceId,
          instanceIdEffective: instanceId ?? mockTelemetryAdminConfig.instanceIdDefault,
          version: mockTelemetryAdminConfig.version + 1,
        },
      });
    }),
  );
  return calls;
}

async function waitForForm() {
  await screen.findByRole('heading', { level: 1, name: 'Telemetry' });
  await screen.findByRole('switch', { name: 'Collect telemetry' });
}

describe('TelemetrySettingsPage', () => {
  it('renders the status card: chips, version, retention in force and the table list', async () => {
    renderPage();
    await waitForForm();

    const status = screen.getByRole('region', { name: 'Status' });
    await within(status).findByText('Reachable');
    expect(within(status).getByText('Configured')).toBeInTheDocument();
    expect(within(status).getByText('PostgreSQL 16.3 GreptimeDB 1.2.1')).toBeInTheDocument();
    expect(within(status).getByText(/30 days \(30days\)/)).toBeInTheDocument();
    const tables = within(status).getByRole('table', { name: 'Telemetry tables' });
    expect(within(tables).getByText('opentelemetry_traces')).toBeInTheDocument();
    expect(within(tables).getByText((12345).toLocaleString())).toBeInTheDocument();
  });

  it('explains how to fix an unconfigured store', async () => {
    server.use(
      http.get(`${API_BASE}/admin/telemetry/status`, () =>
        HttpResponse.json({ data: mockTelemetryStatusUnconfigured }),
      ),
    );
    renderPage();
    await waitForForm();

    const alert = await screen.findByTestId('telemetry-not-configured');
    expect(alert).toHaveTextContent(/GreptimeDB not configured/);
    // Actionable: it points at the Connection section, and says GreptimeDB
    // ships with the application — never an operator command (#567).
    expect(within(alert).getByRole('link', { name: 'Connection' })).toHaveAttribute(
      'href',
      '#telemetry-connection',
    );
    expect(alert).toHaveTextContent(/GreptimeDB is deployed with this application/);
    expect(alert).toHaveTextContent(/take effect once it is reachable, with no restart needed/);
    expect(alert.textContent).not.toMatch(/appctl|compose/i);
  });

  it('sets retentionDays from a preset and saves with If-Match', async () => {
    const calls = capturePut();
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    expect(saveButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '90 days' }));
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(saveButton);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].ifMatch).toBe(String(mockTelemetryAdminConfig.version));
    expect(calls[0].body.retentionDays).toBe(90);
    // The full namespace is sent back (full replace), provenance excluded.
    expect(calls[0].body).toEqual({
      enabled: true,
      retentionDays: 90,
      instanceId: null,
      query: { maxRows: 10000, timeoutSeconds: 30 },
      assistant: {
        enabled: true,
        provider: 'openai',
        modelId: 'gpt-5-mini',
        shareResults: false,
        maxResultRowsToModel: 100,
        maxSteps: 8,
      },
    });
    expect(await screen.findByText('Telemetry settings saved')).toBeInTheDocument();
  });

  it('validates a custom retention between 1 and 3650 days', async () => {
    const calls = capturePut();
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const field = screen.getByLabelText('Retention (days)');
    await user.clear(field);
    await user.type(field, '5000');

    expect(screen.getByText('Must be from 1 to 3650.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    await user.clear(field);
    await user.type(field, '45');
    expect(screen.queryByText('Must be from 1 to 3650.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body.retentionDays).toBe(45);
  });

  it('validates the query limits', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    const timeout = screen.getByLabelText('Query timeout (seconds)');
    await user.clear(timeout);
    await user.type(timeout, '121');
    expect(screen.getByText('Must be from 1 to 120.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('offers a reload when the save is refused with 409', async () => {
    server.use(
      http.put(`${API_BASE}/admin/telemetry/config`, () =>
        HttpResponse.json({ code: 'CONFLICT', message: 'Version mismatch' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await user.click(screen.getByRole('switch', { name: 'Collect telemetry' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    const conflict = await screen.findByTestId('telemetry-conflict');
    expect(conflict).toHaveTextContent(/changed by someone else/);
    await user.click(within(conflict).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByTestId('telemetry-conflict')).not.toBeInTheDocument());
    // Reloaded: the form is back to the server's values.
    expect(await screen.findByRole('switch', { name: 'Collect telemetry' })).toBeChecked();
  });

  it('is read-only without telemetry:write', async () => {
    renderPage({ user: readOnlyAdmin });
    await waitForForm();

    expect(screen.getByTestId('telemetry-read-only-notice')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Collect telemetry' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enable the telemetry assistant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '90 days' })).toBeDisabled();
    expect(screen.getByLabelText('Maximum rows per query')).toBeDisabled();
    expect(screen.getByLabelText('Instance identifier')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('explains that the assistant will not run while AI is off, linking to the AI page', async () => {
    renderPage({ aiEnabled: false });
    await waitForForm();

    const alert = screen.getByTestId('telemetry-ai-off');
    expect(within(alert).getByRole('link', { name: 'AI settings' })).toHaveAttribute(
      'href',
      '/admin/settings/ai',
    );
    // Still editable.
    expect(screen.getByRole('switch', { name: 'Enable the telemetry assistant' })).toBeEnabled();
  });

  it('shows no AI-off notice while AI is on', async () => {
    renderPage({ aiEnabled: true });
    await waitForForm();
    expect(screen.queryByTestId('telemetry-ai-off')).not.toBeInTheDocument();
  });

  it('warns when retention cannot be applied', async () => {
    server.use(
      http.get(`${API_BASE}/admin/telemetry/config`, () =>
        HttpResponse.json({ data: { ...mockTelemetryAdminConfig, retentionApplicable: false } }),
      ),
    );
    renderPage();
    await waitForForm();
    expect(screen.getByTestId('retention-not-applicable')).toBeInTheDocument();
  });

  it('lists enabled catalogue models in the assistant model picker and saves the choice', async () => {
    const calls = capturePut();
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await user.click(screen.getByRole('combobox', { name: /model/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('Not set'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body.assistant.provider).toBeNull();
    expect(calls[0].body.assistant.modelId).toBeNull();
  });

  describe('Instance identifier (#565)', () => {
    it('shows the default as the placeholder and the effective value', async () => {
      renderPage();
      await waitForForm();

      const collection = screen.getByRole('region', { name: 'Collection' });
      const field = within(collection).getByLabelText('Instance identifier');
      expect(field).toHaveValue('');
      expect(field).toHaveAttribute('placeholder', 'my-app');
      expect(within(collection).getByText(/app\.instance\.id/)).toBeInTheDocument();
      expect(within(collection).getByTestId('telemetry-instance-id-effective')).toHaveTextContent(
        'my-app',
      );
    });

    it('saves an override and shows it as the effective value', async () => {
      const calls = capturePut();
      const user = userEvent.setup();
      renderPage();
      await waitForForm();

      await user.type(screen.getByLabelText('Instance identifier'), 'acme-prod');
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].body.instanceId).toBe('acme-prod');
      expect(calls[0].ifMatch).toBe(String(mockTelemetryAdminConfig.version));
      await waitFor(() =>
        expect(screen.getByTestId('telemetry-instance-id-effective')).toHaveTextContent(
          'acme-prod',
        ),
      );
    });

    it('sends null when a stored override is cleared', async () => {
      server.use(
        http.get(`${API_BASE}/admin/telemetry/config`, () =>
          HttpResponse.json({
            data: {
              ...mockTelemetryAdminConfig,
              instanceId: 'acme-prod',
              instanceIdEffective: 'acme-prod',
            },
          }),
        ),
      );
      const calls = capturePut();
      const user = userEvent.setup();
      renderPage();
      await waitForForm();

      const field = screen.getByLabelText('Instance identifier');
      expect(field).toHaveValue('acme-prod');
      await user.clear(field);
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect('instanceId' in calls[0].body).toBe(true);
      expect(calls[0].body.instanceId).toBeNull();
    });

    it('rejects an invalid identifier inline and blocks the save', async () => {
      const calls = capturePut();
      const user = userEvent.setup();
      renderPage();
      await waitForForm();

      const field = screen.getByLabelText('Instance identifier');
      await user.type(field, 'Acme Prod');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(/Use 1-63 lowercase letters/)).toBeInTheDocument();
      const saveButton = screen.getByRole('button', { name: 'Save Changes' });
      expect(saveButton).toBeDisabled();

      await user.clear(field);
      await user.type(field, '-leading-dash');
      expect(screen.getByText(/Use 1-63 lowercase letters/)).toBeInTheDocument();
      expect(saveButton).toBeDisabled();

      await user.clear(field);
      await user.type(field, 'acme.prod_1');
      expect(screen.queryByText(/Use 1-63 lowercase letters/)).not.toBeInTheDocument();
      await user.click(saveButton);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].body.instanceId).toBe('acme.prod_1');
    });
  });

  describe('Connection section (#558, #570)', () => {
    /** Every field only a CUSTOM (external) GreptimeDB needs. */
    const CUSTOM_FIELD_LABELS = [
      'PostgreSQL port',
      'Database',
      'Reader user',
      'Reader password',
      'Admin user (optional)',
      'Admin password',
    ];

    function serveConnection(connection: TelemetryConnection) {
      server.use(
        http.get(`${API_BASE}/admin/telemetry/connection`, () =>
          HttpResponse.json({ data: connection }),
        ),
      );
    }

    function captureConnectionPut(response: TelemetryConnection = mockTelemetryConnectionStored) {
      const calls: { body: TelemetryConnectionInput; ifMatch: string | null }[] = [];
      server.use(
        http.put(`${API_BASE}/admin/telemetry/connection`, async ({ request }) => {
          const body = (await request.json()) as TelemetryConnectionInput;
          calls.push({ body, ifMatch: request.headers.get('If-Match') });
          return HttpResponse.json({
            data: { ...response, source: 'stored', version: response.version + 1 },
          });
        }),
      );
      return calls;
    }

    function captureConnectionTest() {
      const bodies: TelemetryConnectionInput[] = [];
      server.use(
        http.post(`${API_BASE}/admin/telemetry/connection/test`, async ({ request }) => {
          bodies.push((await request.json()) as TelemetryConnectionInput);
          return HttpResponse.json({ data: mockTelemetryConnectionTestResult });
        }),
      );
      return bodies;
    }

    async function connectionSection() {
      await waitForForm();
      const section = screen.getByRole('region', { name: 'Connection' });
      await within(section).findByLabelText('Host');
      return section;
    }

    function expectNoCustomFields(section: HTMLElement) {
      for (const label of CUSTOM_FIELD_LABELS) {
        expect(within(section).queryByLabelText(label)).toBeNull();
      }
    }

    function customBody(body: TelemetryConnectionInput): TelemetryConnectionCustomInput {
      expect(body.host).not.toBeNull();
      return body as TelemetryConnectionCustomInput;
    }

    it.each([
      [mockTelemetryConnectionAutomaticStored, 'Saved in admin settings'],
      [mockTelemetryConnectionCustomStored, 'Saved in admin settings'],
      [mockTelemetryConnectionAutomaticEnvironment, 'Deployment default (environment)'],
      [mockTelemetryConnectionNone, 'Not configured'],
    ])('shows the source chip for %#', async (connection, label) => {
      serveConnection(connection);
      renderPage();
      const section = await connectionSection();
      expect(within(section).getByTestId('telemetry-connection-source')).toHaveTextContent(label);
    });

    it('describes GreptimeDB as deployed with the app, never an operator command (#567)', async () => {
      renderPage();
      const section = await connectionSection();
      const description = within(section).getByTestId('telemetry-connection-description');
      expect(description).toHaveTextContent(/GreptimeDB is deployed with this application/);
      expect(description).toHaveTextContent(/the Automatic host finds it — leave the host blank/);
      expect(description).toHaveTextContent(/Enter a host only to use an external GreptimeDB/);
      expect(description.textContent).not.toMatch(/appctl|compose/i);
    });

    describe('automatic host', () => {
      it.each([
        ['stored', mockTelemetryConnectionAutomaticStored],
        ['environment', mockTelemetryConnectionAutomaticEnvironment],
      ])(
        'hides every port, database and login field and shows the managed panel (%s)',
        async (_source, connection) => {
          serveConnection(connection);
          renderPage();
          const section = await connectionSection();

          const host = within(section).getByLabelText('Host');
          expect(host).toHaveValue('');
          expect(host).toHaveAttribute('placeholder', 'Automatic: greptimedb');
          expect(
            within(section).getByText(
              'Automatic: greptimedb — the GreptimeDB deployed with this application. Set a host only for an external GreptimeDB.',
            ),
          ).toBeInTheDocument();
          expectNoCustomFields(section);
          expect(section.querySelector('input[type="password"]')).toBeNull();
          expect(within(section).queryByTestId('telemetry-connection-custom-note')).toBeNull();

          const panel = within(section).getByTestId('telemetry-connection-deployment-managed');
          expect(within(panel).getByText('Managed by the deployment')).toBeInTheDocument();
          expect(panel).toHaveTextContent(
            'GreptimeDB is deployed with this application. Its address and logins are managed for you — nothing to configure here.',
          );
          const summary = within(panel).getByTestId('telemetry-connection-deployment-summary');
          expect(summary).toHaveTextContent('Addressgreptimedb:4003');
          expect(summary).toHaveTextContent('Databasepublic');
          expect(summary).toHaveTextContent('Reader loginProvided');
          expect(summary).toHaveTextContent('Admin loginProvided');
          expect(within(section).queryByTestId('telemetry-connection-problem')).toBeNull();
        },
      );

      it('never shows a password or a hint in the summary', async () => {
        renderPage();
        const section = await connectionSection();
        expect(section.textContent).not.toMatch(/••••/);
      });

      it('shows the deployment problem as a warning, and a missing admin login', async () => {
        serveConnection(mockTelemetryConnectionAutomaticProblem);
        renderPage();
        const section = await connectionSection();

        const problem = within(section).getByTestId('telemetry-connection-problem');
        expect(problem).toHaveTextContent(mockTelemetryConnectionAutomaticProblem.problem!);
        expect(problem.closest('.MuiAlert-standardWarning, .MuiAlert-colorWarning')).not.toBeNull();
        expect(
          within(section).getByTestId('telemetry-connection-deployment-summary'),
        ).toHaveTextContent('Admin loginNot provisioned');
      });

      it('saves exactly { host: null } with the connection If-Match and no input', async () => {
        const calls = captureConnectionPut();
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Save connection' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        // The connection's own version (3) — not /config's (7).
        expect(calls[0].ifMatch).toBe(String(mockTelemetryConnectionStored.version));
        expect(calls[0].body).toEqual({ host: null });
        expect(await screen.findByText('Telemetry connection saved')).toBeInTheDocument();
      });

      it('saves { host: null } over the deployment default with If-Match 0', async () => {
        serveConnection(mockTelemetryConnectionAutomaticEnvironment);
        const calls = captureConnectionPut(mockTelemetryConnectionAutomaticEnvironment);
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Save connection' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].ifMatch).toBe('0');
        expect(calls[0].body).toEqual({ host: null });
      });

      it('tests exactly { host: null } and renders per-role results', async () => {
        const bodies = captureConnectionTest();
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Test connection' }));
        const result = await within(section).findByTestId('telemetry-connection-test-result');
        expect(result).toHaveTextContent('Tested greptimedb');
        expect(within(result).getByText('Reader login connected')).toBeInTheDocument();
        expect(
          within(result).getByText(/PostgreSQL 16\.3 GreptimeDB 1\.2\.1 · 12 ms/),
        ).toBeInTheDocument();
        expect(within(result).getByText('Admin login failed')).toBeInTheDocument();
        expect(within(result).getByText(/password authentication failed/)).toBeInTheDocument();
        expect(bodies).toEqual([{ host: null }]);
      });

      it('offers no revert: an automatic connection already is the deployment default', async () => {
        renderPage();
        const section = await connectionSection();
        expect(
          within(section).queryByRole('button', { name: 'Revert to deployment default' }),
        ).toBeNull();
        expect(within(section).queryByTestId('telemetry-connection-revert-hint')).toBeNull();
      });

      it('explains an unconfigured deployment and still saves automatic', async () => {
        serveConnection(mockTelemetryConnectionNone);
        const calls = captureConnectionPut(mockTelemetryConnectionNone);
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        expect(within(section).getByTestId('telemetry-connection-none')).toBeInTheDocument();
        expect(
          within(section).getByTestId('telemetry-connection-deployment-summary'),
        ).toHaveTextContent('Reader loginMissing');
        await user.click(within(section).getByRole('button', { name: 'Save connection' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toEqual({ host: null });
      });
    });

    describe('switching between automatic and custom', () => {
      it('reveals the fields with defaults and empty logins when a host is typed', async () => {
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.type(within(section).getByLabelText('Host'), 'greptime.internal');

        expect(within(section).getByLabelText('PostgreSQL port')).toHaveValue(4003);
        expect(within(section).getByLabelText('Database')).toHaveValue('public');
        // The deployment's logins are not copied into the custom form.
        expect(within(section).getByLabelText('Reader user')).toHaveValue('');
        expect(within(section).getByLabelText('Admin user (optional)')).toHaveValue('');
        expect(within(section).getByLabelText('Reader password')).toHaveValue('');
        expect(within(section).getByTestId('telemetry-connection-custom-note')).toHaveTextContent(
          'Connecting to an external GreptimeDB — enter its logins.',
        );
        expect(within(section).queryByTestId('telemetry-connection-deployment-managed')).toBeNull();
        expect(
          within(section).getByText(/^Leave blank for automatic — /),
        ).toBeInTheDocument();
      });

      it('hides the fields again when the host is cleared, and never sends them', async () => {
        const calls = captureConnectionPut();
        const tests = captureConnectionTest();
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        const host = within(section).getByLabelText('Host');
        await user.type(host, 'greptime.internal');
        await user.type(within(section).getByLabelText('Reader user'), 'someone');
        await user.type(within(section).getByLabelText('Reader password'), 'typed-secret');
        await user.clear(host);

        expectNoCustomFields(section);
        expect(
          within(section).getByTestId('telemetry-connection-deployment-managed'),
        ).toBeInTheDocument();

        await user.click(within(section).getByRole('button', { name: 'Test connection' }));
        await waitFor(() => expect(tests).toHaveLength(1));
        expect(tests[0]).toEqual({ host: null });

        await user.click(within(section).getByRole('button', { name: 'Save connection' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toEqual({ host: null });
      });

      it('rejects a host with a scheme, port or path', async () => {
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.type(within(section).getByLabelText('Host'), 'http://greptime:4003');
        expect(
          within(section).getByText('Host name or IP address only — no scheme, port or path.'),
        ).toBeInTheDocument();
        expect(within(section).getByRole('button', { name: 'Test connection' })).toBeDisabled();
      });

      it('requires the logins and passwords when switching an automatic connection to custom', async () => {
        const calls = captureConnectionPut();
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.type(within(section).getByLabelText('Host'), '  greptime.internal  ');
        await user.click(within(section).getByRole('button', { name: 'Save connection' }));
        expect(await within(section).findByText('Enter the read-only user.')).toBeInTheDocument();
        expect(
          within(section).getByText(/Required — no reader password is saved/),
        ).toBeInTheDocument();
        expect(calls).toHaveLength(0);

        await user.type(within(section).getByLabelText('Reader user'), 'ext_reader');
        await user.type(within(section).getByLabelText('Reader password'), 'reader-pw');
        await user.click(within(section).getByRole('button', { name: 'Save connection' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toEqual({
          host: 'greptime.internal',
          pgPort: 4003,
          database: 'public',
          readerUser: 'ext_reader',
          readerPassword: 'reader-pw',
          adminUser: null,
        });
      });
    });

    describe('custom host', () => {
      it('fills the fields, never a password, and describes the saved one by its hint', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        renderPage();
        const section = await connectionSection();

        expect(within(section).getByLabelText('Host')).toHaveValue('greptime.internal');
        expect(within(section).getByLabelText('PostgreSQL port')).toHaveValue(4004);
        expect(within(section).getByLabelText('Database')).toHaveValue('telemetry');
        expect(within(section).getByLabelText('Reader user')).toHaveValue('ext_reader');
        expect(within(section).getByLabelText('Admin user (optional)')).toHaveValue('ext_admin');
        const readerPassword = within(section).getByLabelText('Reader password');
        expect(readerPassword).toHaveAttribute('type', 'password');
        expect(readerPassword).toHaveValue('');
        expect(
          within(section).getByText(/Saved \(••••x9fQ\) — leave blank to keep it/),
        ).toBeInTheDocument();
        expect(within(section).queryByTestId('telemetry-connection-deployment-managed')).toBeNull();
      });

      it('saves the credentials with If-Match and does not send blank passwords', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        const calls = captureConnectionPut(mockTelemetryConnectionCustomStored);
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Save connection' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].ifMatch).toBe(String(mockTelemetryConnectionCustomStored.version));
        expect(calls[0].body).toEqual({
          host: 'greptime.internal',
          pgPort: 4004,
          database: 'telemetry',
          readerUser: 'ext_reader',
          adminUser: 'ext_admin',
        });
        expect(await screen.findByText('Telemetry connection saved')).toBeInTheDocument();
      });

      it('sends a typed password and null for a blank admin user', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        const calls = captureConnectionPut(mockTelemetryConnectionCustomStored);
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.type(within(section).getByLabelText('Reader password'), 's3cret');
        await user.clear(within(section).getByLabelText('Admin user (optional)'));
        expect(within(section).getByLabelText('Admin password')).toBeDisabled();
        await user.click(within(section).getByRole('button', { name: 'Save connection' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        const body = customBody(calls[0].body);
        expect(body.readerPassword).toBe('s3cret');
        expect(body.adminUser).toBeNull();
        expect('adminPassword' in body).toBe(false);
      });

      it('tests the candidate without blank passwords', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        const bodies = captureConnectionTest();
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Test connection' }));
        await waitFor(() => expect(bodies).toHaveLength(1));
        expect(bodies[0]).toEqual({
          host: 'greptime.internal',
          pgPort: 4004,
          database: 'telemetry',
          readerUser: 'ext_reader',
          adminUser: 'ext_admin',
        });
      });

      it('sends { host: null } when a custom host is cleared', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        const calls = captureConnectionPut(mockTelemetryConnectionCustomStored);
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.clear(within(section).getByLabelText('Host'));
        expectNoCustomFields(section);
        await user.click(within(section).getByRole('button', { name: 'Save connection' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toEqual({ host: null });
      });

      it('shows the admin probe as skipped', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        server.use(
          http.post(`${API_BASE}/admin/telemetry/connection/test`, () =>
            HttpResponse.json({
              data: {
                host: 'greptime.internal',
                hostMode: 'custom',
                reader: { success: false, latencyMs: 30, error: 'connection refused' },
                admin: { skipped: true },
              },
            }),
          ),
        );
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        await user.click(within(section).getByRole('button', { name: 'Test connection' }));
        const result = await within(section).findByTestId('telemetry-connection-test-result');
        expect(within(result).getByText('Reader login failed')).toBeInTheDocument();
        expect(within(result).getByText(/connection refused/)).toBeInTheDocument();
        expect(within(result).getByText('Admin login skipped')).toBeInTheDocument();
        expect(result).toHaveTextContent('Tested greptime.internal');
      });

      it('explains what reverting does', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        renderPage();
        const section = await connectionSection();
        expect(within(section).getByTestId('telemetry-connection-revert-hint')).toHaveTextContent(
          /uses the GreptimeDB deployed with this application again/,
        );
      });

      it('reverts with DELETE after confirmation, then shows the managed panel', async () => {
        serveConnection(mockTelemetryConnectionCustomStored);
        const deletes: (string | null)[] = [];
        server.use(
          http.delete(`${API_BASE}/admin/telemetry/connection`, ({ request }) => {
            deletes.push(request.headers.get('If-Match'));
            return HttpResponse.json({ data: mockTelemetryConnectionAutomaticEnvironment });
          }),
        );
        const user = userEvent.setup();
        renderPage();
        const section = await connectionSection();

        const revert = () =>
          within(section).getByRole('button', { name: 'Revert to deployment default' });
        await user.click(revert());
        const dialog = await screen.findByRole('dialog', {
          name: 'Revert to the deployment default?',
        });
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(deletes).toHaveLength(0);
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        await user.click(revert());
        const again = await screen.findByRole('dialog', {
          name: 'Revert to the deployment default?',
        });
        await user.click(within(again).getByRole('button', { name: 'Revert' }));

        await waitFor(() =>
          expect(deletes).toEqual([String(mockTelemetryConnectionCustomStored.version)]),
        );
        await waitFor(() =>
          expect(within(section).getByTestId('telemetry-connection-source')).toHaveTextContent(
            'Deployment default (environment)',
          ),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        // Nothing custom stored any more: nothing to revert, nothing to enter.
        expect(
          within(section).queryByRole('button', { name: 'Revert to deployment default' }),
        ).toBeNull();
        expect(within(section).getByLabelText('Host')).toHaveValue('');
        expectNoCustomFields(section);
      });
    });

    it('refreshes the telemetry config and status after a save', async () => {
      captureConnectionPut();
      let configGets = 0;
      let statusGets = 0;
      server.use(
        http.get(`${API_BASE}/admin/telemetry/config`, () => {
          configGets += 1;
          return HttpResponse.json({ data: mockTelemetryAdminConfig });
        }),
        http.get(`${API_BASE}/admin/telemetry/status`, () => {
          statusGets += 1;
          return HttpResponse.json({ data: mockTelemetryStatusUnconfigured });
        }),
      );
      const user = userEvent.setup();
      renderPage();
      const section = await connectionSection();
      const [configBefore, statusBefore] = [configGets, statusGets];

      await user.click(within(section).getByRole('button', { name: 'Save connection' }));
      await waitFor(() => expect(configGets).toBeGreaterThan(configBefore));
      await waitFor(() => expect(statusGets).toBeGreaterThan(statusBefore));
    });

    it('offers a reload when the save is refused with 409', async () => {
      server.use(
        http.put(`${API_BASE}/admin/telemetry/connection`, () =>
          HttpResponse.json({ code: 'CONFLICT', message: 'Version mismatch' }, { status: 409 }),
        ),
      );
      const user = userEvent.setup();
      renderPage();
      const section = await connectionSection();

      await user.click(within(section).getByRole('button', { name: 'Save connection' }));
      const conflict = await within(section).findByTestId('telemetry-connection-conflict');
      await user.click(within(conflict).getByRole('button', { name: 'Reload' }));
      await waitFor(() =>
        expect(screen.queryByTestId('telemetry-connection-conflict')).not.toBeInTheDocument(),
      );
    });

    it('disables every connection control without telemetry:write (automatic)', async () => {
      renderPage({ user: readOnlyAdmin });
      const section = await connectionSection();

      expect(within(section).getByLabelText('Host')).toBeDisabled();
      for (const name of ['Test connection', 'Save connection']) {
        expect(within(section).getByRole('button', { name })).toBeDisabled();
      }
    });

    it('disables every connection control without telemetry:write (custom)', async () => {
      serveConnection(mockTelemetryConnectionCustomStored);
      renderPage({ user: readOnlyAdmin });
      const section = await connectionSection();

      for (const label of ['Host', ...CUSTOM_FIELD_LABELS]) {
        expect(within(section).getByLabelText(label)).toBeDisabled();
      }
      for (const name of ['Test connection', 'Save connection', 'Revert to deployment default']) {
        expect(within(section).getByRole('button', { name })).toBeDisabled();
      }
    });
  });

  describe('Telemetry services section (#567)', () => {
    it('sits just above the Connection section', async () => {
      renderPage();
      await waitForForm();

      const services = await screen.findByRole('region', { name: 'Telemetry services' });
      const connection = screen.getByRole('region', { name: 'Connection' });
      expect(
        services.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(await within(services).findByRole('button', { name: 'Redeploy' })).toBeEnabled();
    });

    it('is not shown without system_settings:read', async () => {
      renderPage({
        user: {
          ...mockAdminUser,
          permissions: mockAdminUser.permissions.filter((p) => !p.startsWith('system_settings:')),
        },
      });
      await waitForForm();
      expect(screen.queryByRole('region', { name: 'Telemetry services' })).not.toBeInTheDocument();
    });

    it('disables deploying without system_settings:write', async () => {
      renderPage({
        user: {
          ...mockAdminUser,
          permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
        },
      });
      await waitForForm();
      const services = await screen.findByRole('region', { name: 'Telemetry services' });
      expect(await within(services).findByRole('button', { name: 'Redeploy' })).toBeDisabled();
    });

    it('refreshes the status and connection after a successful deploy', async () => {
      let deployed = false;
      let statusGets = 0;
      let connectionGets = 0;
      server.use(
        http.get(`${API_BASE}/admin/telemetry/stack`, () =>
          HttpResponse.json({
            data: deployed
              ? {
                  ...mockTelemetryStackRunning,
                  deploy: { ...mockTelemetryStackRunning.deploy!, jobId: 'job-deploy-1' },
                }
              : mockTelemetryStackMissing,
          }),
        ),
        http.post(`${API_BASE}/admin/telemetry/stack/deploy`, () => {
          deployed = true;
          return HttpResponse.json({ data: { jobId: 'job-deploy-1' } }, { status: 202 });
        }),
        http.get(`${API_BASE}/admin/telemetry/status`, () => {
          statusGets += 1;
          return HttpResponse.json({ data: mockTelemetryStatusUnconfigured });
        }),
        http.get(`${API_BASE}/admin/telemetry/connection`, () => {
          connectionGets += 1;
          return HttpResponse.json({ data: mockTelemetryConnectionStored });
        }),
      );
      const user = userEvent.setup();
      renderPage();
      await waitForForm();

      const services = await screen.findByRole('region', { name: 'Telemetry services' });
      await user.click(await within(services).findByRole('button', { name: 'Deploy GreptimeDB' }));

      expect(await within(services).findByTestId('telemetry-services-succeeded')).toBeInTheDocument();
      // One load each on mount, and one more each after the deploy.
      await waitFor(() => expect(statusGets).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(connectionGets).toBeGreaterThanOrEqual(2));
    });
  });

  describe('Open dashboard (#579)', () => {
    it('links to the dashboard when telemetry is on and the user holds telemetry:query', async () => {
      renderPage();
      const link = await screen.findByRole('link', { name: 'Open dashboard' });
      expect(link).toHaveAttribute('href', '/admin/settings/telemetry/dashboard');
    });

    it('is hidden without telemetry:query', async () => {
      renderPage({
        user: { ...mockAdminUser, permissions: mockAdminUser.permissions.filter((p) => p !== 'telemetry:query') },
      });
      await screen.findByRole('heading', { level: 1, name: 'Telemetry' });
      expect(screen.queryByRole('link', { name: 'Open dashboard' })).not.toBeInTheDocument();
    });

    it.each([
      ['no store is deployed', false as const],
      ['collection is switched off', { available: true, enabled: false, assistantEnabled: false }],
    ])('is hidden when %s', async (_label, telemetryEnabled) => {
      renderPage({ telemetryEnabled });
      await screen.findByRole('heading', { level: 1, name: 'Telemetry' });
      expect(screen.queryByRole('link', { name: 'Open dashboard' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open Telemetry Dashboard' })).not.toBeInTheDocument();
    });

    it('is a 44px icon link on phones', async () => {
      act(() => setViewportWidth(390));
      renderPage();
      const link = await screen.findByRole('link', { name: 'Open Telemetry Dashboard' });
      expect(link).toHaveAttribute('href', '/admin/settings/telemetry/dashboard');
      expect(link).toHaveStyle({ width: '44px', height: '44px' });
    });
  });
});
