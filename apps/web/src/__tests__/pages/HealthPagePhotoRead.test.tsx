/**
 * The Health page's "Read from photo" entry points (issue #64, E2.6): next
 * to "Log measurement" and inside the quick-entry dialog, only when AI and
 * the permissions allow it; Enter manually keeps what was typed; Save to
 * Health refreshes the tiles and History.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../utils/test-utils';
import { server } from '../mocks/server';

vi.mock('../../utils/downscaleImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/downscaleImage')>();
  return { ...actual, downscaleImage: vi.fn(async (file: File) => file) };
});

import HealthPage from '../../pages/HealthPage';
import { PHOTO_READ_HELPER_TEXT } from '../../components/health/PhotoReadDialog';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockLatest } from '../mocks/fixtures/measurements';
import { readingIntake, readingIntakeApi, scaleItems } from '../mocks/fixtures/bodyMetricIntake';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../mocks/fixtures/aiFeatures';

const reader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

let requests: string[];
const onRequest = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
};

function healthApi() {
  const calls = { latest: 0, list: 0 };
  server.use(
    http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    http.get('*/api/measurements/latest', () => {
      calls.latest += 1;
      return HttpResponse.json({ data: { items: mockLatest() } });
    }),
    http.get('*/api/measurements', () => {
      calls.list += 1;
      return HttpResponse.json({ data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } });
    }),
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

const main = () => screen.getByRole('heading', { level: 1, name: 'Health' }).closest('div')!.parentElement!;

describe('HealthPage: Read from photo', () => {
  it('with AI off there is no Read from photo control anywhere, no intake request, and manual entry works', async () => {
    healthApi();
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: false } });

    const log = await screen.findByRole('button', { name: 'Log measurement' });
    expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
    await user.click(log);
    const dialog = await screen.findByRole('dialog', { name: 'Log measurement' });
    expect(await within(dialog).findByRole('textbox', { name: 'Weight' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
    expect(requests.some((r) => r.includes('/intakes') || r.includes('/storage/objects'))).toBe(false);
  });

  it('a user without ai:use sees no Read from photo control', async () => {
    healthApi();
    render(<HealthPage />, {
      wrapperOptions: { user: { ...reader, permissions: reader.permissions.filter((p) => p !== 'ai:use') }, aiEnabled: true },
    });
    await screen.findByRole('button', { name: 'Log measurement' });
    expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
  });

  it('with AI on it sits next to Log measurement; Save to Health refreshes the tiles and History', async () => {
    const calls = healthApi();
    const api = readingIntakeApi({
      existing: [readingIntake('ready', { id: 'intake-old', items: scaleItems() })],
    });
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: true } });

    const header = main();
    expect(within(header).getByRole('button', { name: 'Log measurement' })).toBeInTheDocument();
    await user.click(within(header).getByRole('button', { name: 'Read from photo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Read from photo' });
    const row = await within(dialog).findByTestId('draft-item-row');
    expect(row).toHaveTextContent('Weight 208.4 lb');
    await user.click(within(row).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save to Health' })).toBeEnabled());

    await waitFor(() => expect(calls.list).toBeGreaterThan(0));
    const latestBefore = calls.latest;
    const listBefore = calls.list;
    await user.click(within(dialog).getByRole('button', { name: 'Save to Health' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Read from photo' })).not.toBeInTheDocument());
    expect(api.applied).toBe(1);
    await waitFor(() => expect(calls.latest).toBeGreaterThan(latestBefore));
    await waitFor(() => expect(calls.list).toBeGreaterThan(listBefore));
    expect(await screen.findByText('Saved to Health')).toBeInTheDocument();
  });

  it('opens over the quick-entry dialog; Enter manually returns to it with what was typed', async () => {
    healthApi();
    readingIntakeApi();
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: true } });

    await user.click(await screen.findByRole('button', { name: 'Log measurement' }));
    const log = await screen.findByRole('dialog', { name: 'Log measurement' });
    const weight = await within(log).findByRole('textbox', { name: 'Weight' });
    await user.type(weight, '80.4');

    await user.click(within(log).getByRole('button', { name: 'Read from photo' }));
    const photo = await screen.findByRole('dialog', { name: 'Read from photo' });
    await within(photo).findByText(PHOTO_READ_HELPER_TEXT);
    await user.click(within(photo).getByRole('button', { name: 'Enter manually' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Read from photo' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('dialog', { name: 'Log measurement' })).getByRole('textbox', { name: 'Weight' })).toHaveValue(
      '80.4',
    );
  });

  it('Enter manually from the header flow opens the quick-entry dialog', async () => {
    healthApi();
    server.use(
      http.get('*/api/ai/features', () =>
        HttpResponse.json({
          data: mockAiFeaturesView({
            body_metric_reading: mockBlockedFeatureView('body_metric_reading', 'no_key', 'keys'),
          }),
        }),
      ),
    );
    const user = userEvent.setup();
    render(<HealthPage />, { wrapperOptions: { user: reader, aiEnabled: true } });

    await user.click(await screen.findByRole('button', { name: 'Read from photo' }));
    const photo = await screen.findByRole('dialog', { name: 'Read from photo' });
    // No model for this user: the notice, and its hand-over.
    await user.click(await within(photo).findByRole('button', { name: 'Continue manually' }));
    expect(await screen.findByRole('dialog', { name: 'Log measurement' })).toBeInTheDocument();
    expect(requests.some((r) => r.includes('/intakes'))).toBe(false);
  });
});
