/**
 * ExportHealthDataDialog (issue #191, H7): validation, the request body,
 * polling to ready and the fresh-URL download, the failed state, the 429 and
 * 400 messages, the recent list and accessibility, against MSW.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ExportHealthDataDialog } from '../../../components/health/ExportHealthDataDialog';
import {
  HEALTH_EXPORT_TOO_MANY_MESSAGE,
  type CreateHealthExportInput,
  type HealthExport,
} from '../../../services/healthExport';
import {
  MOCK_HEALTH_EXPORT_ID,
  mockHealthExport,
  mockHealthExportDownloadUrl,
  mockReadyHealthExport,
} from '../../mocks/fixtures/healthExports';

const TODAY = '2026-10-01';

function renderDialog(props: { openUrl?: (url: string) => void; onClose?: () => void } = {}) {
  const openUrl = props.openUrl ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <ExportHealthDataDialog open onClose={onClose} today={TODAY} pollIntervalMs={5} openUrl={openUrl} />,
  );
  return { ...utils, openUrl, onClose };
}

/** Records every POST body; answers the created export as pending. */
function capturePosts(answer?: (body: CreateHealthExportInput) => Response) {
  const posts: CreateHealthExportInput[] = [];
  server.use(
    http.post('*/api/health/exports', async ({ request }) => {
      const body = (await request.json()) as CreateHealthExportInput;
      posts.push(body);
      if (answer) return answer(body);
      return HttpResponse.json({ data: mockHealthExport({ ...body, status: 'pending' }) }, { status: 202 });
    }),
  );
  return posts;
}

/** `GET /:id` answers each status in turn, then the last one forever. */
function statusSequence(...steps: HealthExport[]) {
  const calls: string[] = [];
  server.use(
    http.get('*/api/health/exports/:id', ({ params }) => {
      calls.push(String(params.id));
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      return HttpResponse.json({ data: { ...step, id: String(params.id) } });
    }),
  );
  return calls;
}

describe('ExportHealthDataDialog', () => {
  it('shows the format, range and dataset pickers with all datasets on, and has no axe violations', async () => {
    const { baseElement } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    expect(within(dialog).getByRole('radio', { name: /PDF.*PDF report for your doctor/ })).toBeChecked();
    for (const name of [/^JSON/, /^CSV \(zip\)/, /^Excel/]) {
      expect(within(dialog).getByRole('radio', { name })).not.toBeChecked();
    }
    expect(within(dialog).getByRole('radio', { name: 'Last 3 months' })).toBeChecked();
    expect(within(dialog).getByText('From 2026-07-01 to 2026-10-01')).toBeInTheDocument();
    for (const name of [
      'Profile',
      'Body (weight, body fat, waist)',
      'Vitals (blood pressure, resting heart rate)',
      'Blood work',
      'Wellness / mood (check-in scores)',
      'Documents index',
    ]) {
      expect(within(dialog).getByRole('checkbox', { name })).toBeChecked();
    }
    expect(within(dialog).getByRole('switch', { name: /Include edit history/ })).not.toBeChecked();

    expect(await within(dialog).findByText(/No exports yet/)).toBeInTheDocument();
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('refuses to send with no dataset chosen', async () => {
    const posts = capturePosts();
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });
    await within(dialog).findByText(/No exports yet/);

    for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box);
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    expect(within(dialog).getByText('Choose at least one dataset')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('refuses a custom range that starts after it ends, or ends in the future', async () => {
    const posts = capturePosts();
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    const from = within(dialog).getByLabelText('From');
    const to = within(dialog).getByLabelText('To');
    // Custom starts from the range that was showing.
    expect(from).toHaveValue('2026-07-01');
    expect(to).toHaveValue(TODAY);

    await user.clear(from);
    await user.type(from, '2026-09-15');
    await user.clear(to);
    await user.type(to, '2026-09-01');
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));
    expect(within(dialog).getByText('The start date must not be after the end date')).toBeInTheDocument();

    await user.clear(to);
    await user.type(to, '2026-10-05');
    expect(within(dialog).getByText('The end date cannot be in the future')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('sends exactly the chosen format, range, datasets and history flag', async () => {
    const posts = capturePosts();
    statusSequence(mockHealthExport({ status: 'running' }));
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('radio', { name: /^JSON/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'Last 6 months' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Documents index' }));
    await user.click(within(dialog).getByRole('switch', { name: /Include edit history/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      format: 'json',
      from: '2026-04-01',
      to: TODAY,
      datasets: ['profile', 'body', 'vitals', 'labs', 'wellness'],
      includeHistory: true,
    });
  });

  it('sends a custom range as typed', async () => {
    const posts = capturePosts();
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    const from = within(dialog).getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2025-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ format: 'pdf', from: '2025-01-01', to: TODAY });
  });

  it('polls a new export to ready, then downloads it through a freshly minted URL', async () => {
    capturePosts();
    const url = mockHealthExportDownloadUrl(MOCK_HEALTH_EXPORT_ID);
    const ready = mockReadyHealthExport({ download: { url, expiresAt: '2026-10-01T09:05:00.000Z' } });
    const calls = statusSequence(mockHealthExport({ status: 'running' }), ready);
    const user = userEvent.setup();
    const { openUrl } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    const status = within(dialog).getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Preparing your export'));
    await waitFor(() => expect(status).toHaveTextContent('Your export is ready to download.'));

    const item = within(dialog).getByRole('listitem', { name: /PDF, 2026-07-01 to 2026-10-01, Ready/ });
    expect(item).toHaveTextContent('47 KB');
    expect(item).toHaveTextContent(/Expires/);

    // Polling stopped at ready.
    const pollCalls = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(pollCalls);

    await user.click(within(item).getByRole('button', { name: /^Download PDF/ }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(url));
    // The URL came from a GET made for the click, not from the poll.
    expect(calls).toHaveLength(pollCalls + 1);
  });

  it('shows a failed export with its message and no download', async () => {
    capturePosts();
    statusSequence(
      mockHealthExport({ status: 'failed', error: 'The export could not be created. Please try again.' }),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('The export could not be created. Please try again.'),
    );
    const item = within(dialog).getByRole('listitem', { name: /Failed/ });
    expect(within(item).queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('explains a 429 (too many exports in progress)', async () => {
    capturePosts(() =>
      HttpResponse.json(
        { message: 'You already have 3 exports in progress; wait for one to finish', code: 'TOO_MANY_REQUESTS' },
        { status: 429 },
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    expect(await within(dialog).findByText(HEALTH_EXPORT_TOO_MANY_MESSAGE)).toBeInTheDocument();
  });

  it('explains a 400 with the API field messages', async () => {
    capturePosts(() =>
      HttpResponse.json(
        {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: { issues: [{ path: 'to', message: '`to` may not be in the future' }] },
        },
        { status: 400 },
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    expect(
      await within(dialog).findByText('Check the export settings: `to` may not be in the future.'),
    ).toBeInTheDocument();
  });

  it('lists recent exports, keeps polling the unfinished one, and downloads a ready one', async () => {
    const readyId = '0b8f3c1e-5d2a-4e7b-9a10-6c2d8e4f1a02';
    const runningId = '0b8f3c1e-5d2a-4e7b-9a10-6c2d8e4f1a03';
    server.use(
      http.get('*/api/health/exports', () =>
        HttpResponse.json({
          data: {
            items: [
              mockHealthExport({ id: runningId, status: 'running', format: 'xlsx' }),
              mockReadyHealthExport({ id: readyId, format: 'json', fileName: 'app-health-2026-07-01-2026-10-01.json' }),
              mockReadyHealthExport({
                id: '0b8f3c1e-5d2a-4e7b-9a10-6c2d8e4f1a04',
                status: 'expired',
                format: 'csv',
              }),
            ],
          },
        }),
      ),
    );
    const polled: string[] = [];
    server.use(
      http.get('*/api/health/exports/:id', ({ params }) => {
        const id = String(params.id);
        polled.push(id);
        if (id === runningId) return HttpResponse.json({ data: mockHealthExport({ id, status: 'running', format: 'xlsx' }) });
        return HttpResponse.json({
          data: mockReadyHealthExport({
            id,
            format: 'json',
            download: { url: mockHealthExportDownloadUrl(id), expiresAt: '2026-10-01T09:05:00.000Z' },
          }),
        });
      }),
    );
    const user = userEvent.setup();
    const { openUrl } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    const list = await within(dialog).findByRole('list', { name: 'Recent exports' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAccessibleName(/^Excel, .* Preparing$/);
    expect(within(items[0]).getByRole('progressbar')).toBeInTheDocument();
    expect(items[2]).toHaveAccessibleName(/^CSV \(zip\), .* Expired$/);
    expect(within(items[2]).queryByRole('button', { name: /Download/ })).toBeNull();

    await waitFor(() => expect(polled.filter((id) => id === runningId).length).toBeGreaterThan(1));
    expect(polled).not.toContain(readyId);

    await user.click(within(items[1]).getByRole('button', { name: /^Download JSON/ }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(mockHealthExportDownloadUrl(readyId)));
  });

  it('says so when a ready export has expired by the time it is downloaded', async () => {
    server.use(
      http.get('*/api/health/exports', () =>
        HttpResponse.json({ data: { items: [mockReadyHealthExport()] } }),
      ),
      http.get('*/api/health/exports/:id', () =>
        HttpResponse.json({ data: mockReadyHealthExport({ status: 'expired' }) }),
      ),
    );
    const user = userEvent.setup();
    const { openUrl } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export health data' });

    await user.click(await within(dialog).findByRole('button', { name: /^Download PDF/ }));

    expect(await within(dialog).findByText('This export has expired. Create a new one.')).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('listitem', { name: /Expired$/ })).toBeInTheDocument();
  });

  it('closes from the Close button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
