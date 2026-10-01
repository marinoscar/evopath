/**
 * `/settings/danger-zone` (issue #202): the per-user factory reset.
 *
 * Covers the confirmation gate (checkbox AND exact, case-sensitive phrase),
 * the POST body, polling the job to success or failure, and the live summary
 * counts (with the static list surviving a failed summary).
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import UserDangerZonePage from '../../pages/UserDangerZonePage';

const SUMMARY = {
  workouts: 37,
  gyms: 4,
  measurements: 210,
  programs: 2,
  trainingRuns: 5,
  customExercises: 1,
  photos: 112,
  aiKeys: 1,
  accessTokens: 3,
  notifications: 18,
};

/** Poll timing is real (1.5 s); give each settled state room to arrive. */
const POLL_WAIT = { timeout: 5000 };

function mockSummary(body: unknown = SUMMARY, status = 200) {
  server.use(
    http.get('*/api/user-data/summary', () =>
      status === 200
        ? HttpResponse.json({ data: body })
        : HttpResponse.json({ message: 'boom' }, { status }),
    ),
  );
}

function captureReset(
  jobResponses: Array<Record<string, unknown>>,
): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let poll = 0;
  server.use(
    http.post('*/api/user-data/reset', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } }, { status: 202 });
    }),
    http.get('*/api/user-data/reset/:jobId', ({ params }) => {
      const next = jobResponses[Math.min(poll, jobResponses.length - 1)];
      poll += 1;
      return HttpResponse.json({ data: { jobId: params.jobId, ...next } });
    }),
  );
  return { bodies };
}

async function renderPage() {
  const user = userEvent.setup();
  const result = render(<UserDangerZonePage />);
  return { user, ...result };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Delete all my data…' }));
  return screen.findByRole('dialog');
}

describe('UserDangerZonePage', () => {
  it('renders the warning panel, what stays, and live summary counts', async () => {
    mockSummary();
    await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Delete all my data' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Danger Zone' })).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

    expect(await screen.findByText('37 workouts')).toBeInTheDocument();
    expect(screen.getByText('4 gyms')).toBeInTheDocument();
    expect(screen.getByText('112 photos')).toBeInTheDocument();
    expect(screen.getByText('1 AI provider key')).toBeInTheDocument();

    expect(screen.getByText('Your sign-in and account, and your role')).toBeInTheDocument();
    expect(screen.getByText('The security audit log')).toBeInTheDocument();
  });

  it('shows skeletons while the summary loads', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('*/api/user-data/summary', async () => {
        await gate;
        return HttpResponse.json({ data: SUMMARY });
      }),
    );
    await renderPage();
    expect(screen.getAllByTestId('summary-count-skeleton').length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText('37 workouts')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-count-skeleton')).not.toBeInTheDocument();
  });

  it('still renders the static list when the summary fails', async () => {
    mockSummary(null, 500);
    await renderPage();
    expect(await screen.findByText(/Could not load how much data you have/)).toBeInTheDocument();
    expect(screen.getByText('Workouts')).toBeInTheDocument();
    expect(screen.getByText('Photos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete all my data…' })).toBeEnabled();
  });

  it('tolerates missing summary keys', async () => {
    mockSummary({ workouts: 2 });
    await renderPage();
    expect(await screen.findByText('2 workouts')).toBeInTheDocument();
    expect(screen.getByText('Gyms')).toBeInTheDocument();
  });

  it('keeps confirm disabled until BOTH the checkbox and the exact phrase are given', async () => {
    mockSummary();
    const { user } = await renderPage();
    const dialog = await openDialog(user);

    expect(dialog).toHaveAttribute('aria-describedby');
    const confirm = within(dialog).getByRole('button', { name: 'Delete all my data' });
    expect(confirm).toBeDisabled();
    // Cancel is the default-focused action.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    const phrase = within(dialog).getByLabelText('Confirmation phrase');
    await user.type(phrase, 'DELETE MY DATA');
    expect(confirm).toBeDisabled();

    await user.clear(phrase);
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeDisabled();

    await user.type(phrase, 'DELETE MY DATA');
    expect(confirm).toBeEnabled();
  });

  it('keeps confirm disabled for a wrong-case phrase', async () => {
    mockSummary();
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'delete my data');
    expect(within(dialog).getByRole('button', { name: 'Delete all my data' })).toBeDisabled();
  });

  it('resets the dialog state when it is closed', async () => {
    mockSummary();
    const { user } = await renderPage();
    let dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'DELETE MY DATA');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openDialog(user);
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Confirmation phrase')).toHaveValue('');
  });

  it('POSTs the phrase, shows progress, and polls to a success summary', async () => {
    mockSummary();
    const { bodies } = captureReset([
      { status: 'running' },
      {
        status: 'succeeded',
        result: { workouts: 37, photos: 112, storageObjectsDeleted: 113, storageObjectsFailed: 0 },
      },
    ]);
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'DELETE MY DATA');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all my data' }));

    expect(await screen.findByText(/Deleting your data…/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Deleting your data' })).toBeInTheDocument();
    await waitFor(() => expect(bodies).toEqual([{ confirmation: 'DELETE MY DATA' }]));

    expect(
      await screen.findByRole('heading', { name: 'Your data has been deleted' }, POLL_WAIT),
    ).toBeInTheDocument();
    const done = screen.getByRole('dialog');
    expect(within(done).getByText('37 workouts')).toBeInTheDocument();
    expect(within(done).getByText('112 photos')).toBeInTheDocument();
    expect(within(done).getByText('113 stored files')).toBeInTheDocument();
    expect(within(done).queryByText(/could not be removed from storage/)).not.toBeInTheDocument();
    expect(within(done).getByRole('button', { name: 'Go to home' })).toBeInTheDocument();
  }, 10000);

  it('warns when some stored files could not be removed', async () => {
    mockSummary();
    captureReset([
      { status: 'succeeded', result: { workouts: 1, storageObjectsDeleted: 2, storageObjectsFailed: 3 } },
    ]);
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'DELETE MY DATA');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all my data' }));

    expect(
      await screen.findByText(/3 stored files could not be removed from storage/, {}, POLL_WAIT),
    ).toBeInTheDocument();
  }, 10000);

  it('shows the error on a failed job and allows a retry', async () => {
    mockSummary();
    captureReset([{ status: 'failed', error: 'Storage unavailable' }]);
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'DELETE MY DATA');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all my data' }));

    expect(await screen.findByText('Storage unavailable', {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.getByText('The reset did not finish')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  }, 10000);

  it('shows the API error when the reset is rejected', async () => {
    mockSummary();
    server.use(
      http.post('*/api/user-data/reset', () =>
        HttpResponse.json({ message: 'Confirmation phrase does not match' }, { status: 400 }),
      ),
    );
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'DELETE MY DATA');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all my data' }));

    expect(await screen.findByText('Confirmation phrase does not match')).toBeInTheDocument();
  });
});
