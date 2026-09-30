/**
 * Admin → Danger Zone → Factory reset (`/admin/settings/factory-reset`),
 * issue #211.
 *
 * Mirrors `UserDangerZonePage.test.tsx` (#202): the confirmation gate
 * (checkbox AND exact, case-sensitive phrase), the POST body, polling the job
 * to success or failure, the live deployment-wide summary counts (with the
 * static list surviving a failed summary), and the backup recommendation.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import FactoryResetPage from '../../../pages/Admin/FactoryResetPage';

const SUMMARY = {
  otherUsers: 12,
  workouts: 340,
  gyms: 9,
  measurements: 1500,
  programs: 14,
  trainingRuns: 22,
  storageObjects: 1204,
  jobs: 800,
  notifications: 95,
  allowlistEntries: 1,
  broadcasts: 3,
  aiRuns: 60,
  customExercises: 4,
  customEquipment: 1,
};

const PHRASE = 'FACTORY RESET';
const OPEN_BUTTON = 'Factory reset…';
const CONFIRM_BUTTON = 'Factory reset';

/** Poll timing is real (1.5 s); give each settled state room to arrive. */
const POLL_WAIT = { timeout: 5000 };

function mockSummary(body: unknown = SUMMARY, status = 200) {
  server.use(
    http.get('*/api/admin/factory-reset/summary', () =>
      status === 200
        ? HttpResponse.json({ data: body })
        : HttpResponse.json({ message: 'boom' }, { status }),
    ),
  );
}

function captureReset(jobResponses: Array<Record<string, unknown>>): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let poll = 0;
  server.use(
    http.post('*/api/admin/factory-reset', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } }, { status: 202 });
    }),
    http.get('*/api/admin/factory-reset/:jobId', ({ params }) => {
      // This pattern also matches `/summary`: returning nothing falls through
      // to the summary handler registered by `mockSummary`.
      if (params.jobId === 'summary') return undefined;
      const next = jobResponses[Math.min(poll, jobResponses.length - 1)];
      poll += 1;
      return HttpResponse.json({ data: { jobId: params.jobId, ...next } });
    }),
  );
  return { bodies };
}

async function renderPage() {
  const user = userEvent.setup();
  const result = render(<FactoryResetPage />, {
    user: mockAdminUser,
    route: '/admin/settings/factory-reset',
  });
  return { user, ...result };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: OPEN_BUTTON }));
  return screen.findByRole('dialog');
}

async function confirmReset(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await openDialog(user);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.type(within(dialog).getByLabelText('Confirmation phrase'), PHRASE);
  await user.click(within(dialog).getByRole('button', { name: CONFIRM_BUTTON }));
}

describe('FactoryResetPage', () => {
  it('renders the warning panel, what stays, and live deployment-wide counts', async () => {
    mockSummary();
    await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Factory reset' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Danger Zone' })).toBeInTheDocument();
    expect(screen.getByText(/whole application for everyone/i)).toBeInTheDocument();
    expect(screen.getByText(/It cannot be undone/)).toBeInTheDocument();

    expect(await screen.findByText('12 other users and their accounts')).toBeInTheDocument();
    expect(screen.getByText('340 workouts')).toBeInTheDocument();
    expect(screen.getByText('1,204 files in storage')).toBeInTheDocument();
    expect(screen.getByText('800 jobs in the job history')).toBeInTheDocument();
    expect(screen.getByText('1 allowlist entry')).toBeInTheDocument();
    expect(screen.getByText('1 custom equipment item')).toBeInTheDocument();

    for (const kept of [
      'Your admin account and session',
      'Roles and permissions',
      'System settings and integrations',
      'The exercise and equipment catalog',
      'Worker nodes',
      'Database backups',
      'The security audit log',
    ]) {
      expect(screen.getByText(kept)).toBeInTheDocument();
    }
  });

  it('recommends a database backup and links to the backup page', async () => {
    mockSummary();
    await renderPage();
    expect(screen.getByText('Take a database backup first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Database Backup' })).toHaveAttribute(
      'href',
      '/admin/settings/db-backup',
    );
  });

  it('shows skeletons while the summary loads', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('*/api/admin/factory-reset/summary', async () => {
        await gate;
        return HttpResponse.json({ data: SUMMARY });
      }),
    );
    await renderPage();
    expect(screen.getAllByTestId('summary-count-skeleton').length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText('340 workouts')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-count-skeleton')).not.toBeInTheDocument();
  });

  it('still renders the static list when the summary fails', async () => {
    mockSummary(null, 500);
    await renderPage();
    expect(
      await screen.findByText(/Could not load how much data this deployment holds/),
    ).toBeInTheDocument();
    expect(screen.getByText('Every other user and their account')).toBeInTheDocument();
    expect(screen.getByText('Workouts')).toBeInTheDocument();
    expect(screen.getByText('Job history')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_BUTTON })).toBeEnabled();
  });

  it('tolerates missing and extra summary keys', async () => {
    mockSummary({ workouts: 2, somethingNew: 7 });
    await renderPage();
    expect(await screen.findByText('2 workouts')).toBeInTheDocument();
    expect(screen.getByText('Gyms')).toBeInTheDocument();
  });

  it('keeps confirm disabled until BOTH the checkbox and the exact phrase are given', async () => {
    mockSummary();
    const { user } = await renderPage();
    const dialog = await openDialog(user);

    expect(dialog).toHaveAttribute('aria-describedby');
    const confirm = within(dialog).getByRole('button', { name: CONFIRM_BUTTON });
    expect(confirm).toBeDisabled();
    // Cancel is the default-focused action.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(
      within(dialog).getByLabelText(
        'I understand this permanently deletes all users and all data for everyone and cannot be undone',
      ),
    ).toBeInTheDocument();

    const phrase = within(dialog).getByLabelText('Confirmation phrase');
    await user.type(phrase, PHRASE);
    expect(confirm).toBeDisabled();

    await user.clear(phrase);
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeDisabled();

    await user.type(phrase, PHRASE);
    expect(confirm).toBeEnabled();
  });

  it('accepts a pasted phrase', async () => {
    mockSummary();
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByLabelText('Confirmation phrase'));
    await user.paste(PHRASE);
    expect(within(dialog).getByRole('button', { name: CONFIRM_BUTTON })).toBeEnabled();
  });

  it('keeps confirm disabled for a wrong-case phrase', async () => {
    mockSummary();
    const { user } = await renderPage();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'factory reset');
    expect(within(dialog).getByRole('button', { name: CONFIRM_BUTTON })).toBeDisabled();
  });

  it('resets the dialog state when it is closed', async () => {
    mockSummary();
    const { user } = await renderPage();
    let dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), PHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openDialog(user);
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Confirmation phrase')).toHaveValue('');
  });

  it('POSTs the phrase, shows non-dismissable progress, and polls to a success summary', async () => {
    mockSummary();
    const { bodies } = captureReset([
      { status: 'running' },
      {
        status: 'succeeded',
        result: {
          usersDeleted: 12,
          workouts: 340,
          workerNodesReassigned: 2,
          storageObjectsDeleted: 1204,
          storageObjectsFailed: 0,
        },
      },
    ]);
    const { user } = await renderPage();
    await confirmReset(user);

    expect(await screen.findByText(/Erasing all application data…/)).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Erasing all application data' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(bodies).toEqual([{ confirmation: PHRASE }]));

    // Escape does not close the dialog while the job runs.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { name: 'The factory reset is complete' }, POLL_WAIT),
    ).toBeInTheDocument();
    const done = screen.getByRole('dialog');
    expect(within(done).getByText('12 user accounts')).toBeInTheDocument();
    expect(within(done).getByText('2 worker nodes reassigned')).toBeInTheDocument();
    expect(within(done).getByText('340 workouts')).toBeInTheDocument();
    expect(within(done).getByText('1,204 files in storage')).toBeInTheDocument();
    expect(within(done).queryByText(/could not be removed from storage/)).not.toBeInTheDocument();
    expect(within(done).getByRole('button', { name: 'Back to admin settings' })).toBeInTheDocument();
  }, 10000);

  it('warns when some stored files could not be removed', async () => {
    mockSummary();
    captureReset([
      { status: 'succeeded', result: { workouts: 1, storageObjectsDeleted: 2, storageObjectsFailed: 3 } },
    ]);
    const { user } = await renderPage();
    await confirmReset(user);

    expect(
      await screen.findByText(/3 files could not be removed from storage/, {}, POLL_WAIT),
    ).toBeInTheDocument();
  }, 10000);

  it('shows the error on a failed job and allows a retry', async () => {
    mockSummary();
    captureReset([{ status: 'failed', error: 'Storage unavailable' }]);
    const { user } = await renderPage();
    await confirmReset(user);

    expect(await screen.findByText('Storage unavailable', {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.getByText('The factory reset did not finish')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  }, 10000);

  it('shows the API error when the reset is rejected', async () => {
    mockSummary();
    server.use(
      http.post('*/api/admin/factory-reset', () =>
        HttpResponse.json({ message: 'Confirmation phrase does not match' }, { status: 400 }),
      ),
    );
    const { user } = await renderPage();
    await confirmReset(user);

    expect(await screen.findByText('Confirmation phrase does not match')).toBeInTheDocument();
  });
});
