/**
 * The Health page's "Import lab report" entry point (H4, #188): shown beside
 * "Read from photo" only when AI and the permissions allow it, opening
 * `LabReportDialog`; a save refreshes the tiles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import HealthPage from '../../pages/HealthPage';
import { IMPORT_LAB_REPORT_LABEL } from '../../components/health/LabReportButton';
import { LAB_REPORT_TITLE } from '../../components/health/LabReportDialog';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockLatest } from '../mocks/fixtures/measurements';
import { labIntake, labIntakeApi, panelItems } from '../mocks/fixtures/labReportIntake';

const reader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

let requests: string[];
const onRequest = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
};

function healthApi() {
  const calls = { latest: 0 };
  server.use(
    http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    http.get('*/api/measurements/latest', () => {
      calls.latest += 1;
      return HttpResponse.json({ data: { items: mockLatest() } });
    }),
    http.get('*/api/measurements', () =>
      HttpResponse.json({ data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } }),
    ),
  );
  return calls;
}

beforeEach(() => {
  resetMeasurementCatalogCache();
  requests = [];
  server.events.on('request:start', onRequest);
});
afterEach(() => {
  server.events.removeListener('request:start', onRequest);
});

describe('HealthPage: Import lab report', () => {
  it('with AI off there is no Import lab report control and no intake request', async () => {
    healthApi();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: false } });
    await screen.findByRole('button', { name: 'Log measurement' });
    expect(screen.queryByRole('button', { name: IMPORT_LAB_REPORT_LABEL })).not.toBeInTheDocument();
    expect(requests.some((r) => r.includes('/intakes'))).toBe(false);
  });

  it('a user without health_data:write sees no Import lab report control', async () => {
    healthApi();
    render(<HealthPage />, {
      wrapperOptions: {
        user: { ...reader, permissions: reader.permissions.filter((p) => p !== 'health_data:write') },
        aiEnabled: true,
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Health' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: IMPORT_LAB_REPORT_LABEL })).not.toBeInTheDocument();
  });

  it('with AI on it opens the lab report dialog; saving refreshes the tiles', async () => {
    const calls = healthApi();
    const api = labIntakeApi({
      existing: [
        labIntake('ready', {
          items: panelItems().filter((item) => item.value.analyteKey !== null),
          context: { collectionDate: '2026-09-15', labName: null },
        }),
      ],
    });
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: true } });

    await user.click(await screen.findByRole('button', { name: IMPORT_LAB_REPORT_LABEL }));
    const dialog = await screen.findByRole('dialog', { name: LAB_REPORT_TITLE });
    await within(dialog).findByTestId('lab-report-review');
    await user.click(within(dialog).getByRole('button', { name: 'Accept all (6)' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save to Health' })).toBeEnabled());

    const latestBefore = calls.latest;
    await user.click(within(dialog).getByRole('button', { name: 'Save to Health' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LAB_REPORT_TITLE })).not.toBeInTheDocument());
    expect(api.applied).toBe(1);
    await waitFor(() => expect(calls.latest).toBeGreaterThan(latestBefore));
    expect(await screen.findByText('Saved 6 lab results to Health')).toBeInTheDocument();
  });
});
