/**
 * PlanHistoryPage (E5.6): versions, the diff against the previous version,
 * Restore this version (If-Match, a new version), the change log with keyset
 * paging, gating and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanHistoryPage from '../../../pages/Train/PlanHistoryPage';
import {
  mockChangeLog,
  mockProgram,
  mockVersion,
  mockVersionSummaries,
  PROGRAM_ID,
  RUN_ID,
} from '../../mocks/fixtures/programs';
import { UNDONE_MESSAGE } from '../../../components/training/PlanAdjustedBanner';
import type { ChangeLogEntry } from '../../../services/programs';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function serveHistory() {
  let program = mockProgram();
  let versions = [...mockVersionSummaries];
  const reverts: Array<{ ifMatch: string | null; body: unknown }> = [];
  const cursors: Array<string | null> = [];
  server.use(
    http.get(`*/api/programs/${PROGRAM_ID}`, () => HttpResponse.json({ data: program })),
    http.get(`*/api/programs/${PROGRAM_ID}/versions`, () => HttpResponse.json({ data: versions })),
    http.get(`*/api/programs/${PROGRAM_ID}/versions/:n`, ({ params }) =>
      HttpResponse.json({ data: mockVersion(Math.min(2, Number(params.n))) }),
    ),
    http.get(`*/api/programs/${PROGRAM_ID}/change-log`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      cursors.push(cursor);
      return HttpResponse.json({
        data: cursor ? { items: [mockChangeLog[1]], nextCursor: null } : { items: [mockChangeLog[0]], nextCursor: 'c1' },
      });
    }),
    http.post(`*/api/programs/${PROGRAM_ID}/revert`, async ({ request }) => {
      reverts.push({ ifMatch: request.headers.get('If-Match'), body: await request.json() });
      program = { ...program, currentVersion: 3, version: { ...program.version, versionNumber: 3, origin: 'revert' } };
      versions = [
        { versionNumber: 3, origin: 'revert', createdAt: new Date().toISOString(), runId: null, changeLogId: 'cl-3', summary: 'Restored version 1' },
        ...versions,
      ];
      return HttpResponse.json({ data: program });
    }),
  );
  return { reverts, cursors };
}

function renderHistory(permissions = user.permissions) {
  return render(
    <Routes>
      <Route path="/train/plans/:programId/history" element={<PlanHistoryPage />} />
    </Routes>,
    { wrapperOptions: { route: `/train/plans/${PROGRAM_ID}/history`, aiEnabled: false, user: { ...user, permissions } } },
  );
}

describe('PlanHistoryPage', () => {
  it('lists versions and shows the diff of the latest against the one before', async () => {
    serveHistory();
    renderHistory();
    const list = await screen.findByRole('list', { name: 'Versions' });
    expect(within(list).getByTestId('version-2')).toHaveTextContent('Version 2');
    expect(within(list).getByTestId('version-2')).toHaveTextContent('Current');
    expect(await screen.findByTestId('diff-summary')).toHaveTextContent('1 prescription changed.');
    expect(screen.getByTestId('diff-change')).toHaveTextContent('Week 1, Upper A: Bench press 4 x 8-10 @ RPE 8 to 3 x 8-10 @ RPE 8');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument();
  });

  it('restores an earlier version as a new version', async () => {
    const api = serveHistory();
    renderHistory();
    await userEvent.click(await screen.findByTestId('version-1'));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore version 1?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored version 1 as version 3.')).toBeInTheDocument();
    expect(api.reverts).toEqual([{ ifMatch: '2', body: { toVersion: 1 } }]);
    expect(await screen.findByTestId('version-3')).toHaveTextContent('Current');
  });

  it('pages the change log with the cursor', async () => {
    const api = serveHistory();
    renderHistory();
    const log = await screen.findByRole('list', { name: 'Change log' });
    expect(within(log).getAllByTestId('change-log-entry')).toHaveLength(1);
    expect(within(log).getByText('You')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(log).getAllByTestId('change-log-entry')).toHaveLength(2));
    expect(within(log).getByText('AI')).toBeInTheDocument();
    expect(api.cursors).toEqual([null, 'c1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('hides restore without programs:write', async () => {
    serveHistory();
    renderHistory(user.permissions.filter((p) => p !== 'programs:write'));
    await userEvent.click(await screen.findByTestId('version-1'));
    await screen.findByTestId('diff-summary');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument();
  });

  it('undoes the latest applied change from the change log (E5.8)', async () => {
    const adapted: ChangeLogEntry = {
      ...mockChangeLog[1],
      id: 'cl-3',
      kind: 'adapted',
      fromVersion: 1,
      toVersion: 2,
      summary: 'Coach lowered squat volume',
      operations: [{ op: 'set_prescription', description: 'Week 2, Back squat: 3 sets' }],
    };
    let items: ChangeLogEntry[] = [adapted, { ...mockChangeLog[1] }];
    const reverts: Array<{ ifMatch: string | null; body: unknown }> = [];
    serveHistory();
    server.use(
      http.get(`*/api/programs/${PROGRAM_ID}/change-log`, () => HttpResponse.json({ data: { items, nextCursor: null } })),
      http.post(`*/api/programs/${PROGRAM_ID}/revert`, async ({ request }) => {
        reverts.push({ ifMatch: request.headers.get('If-Match'), body: await request.json() });
        items = [{ ...adapted, status: 'reverted' }, items[1]];
        return HttpResponse.json({ data: mockProgram({ currentVersion: 3 }) });
      }),
    );
    renderHistory();
    const log = await screen.findByRole('list', { name: 'Change log' });
    const rows = await within(log).findAllByTestId('change-log-entry');
    expect(within(rows[0]).getByTestId('operation-line')).toHaveTextContent('Week 2, Back squat: 3 sets');
    expect(within(rows[1]).queryByRole('button', { name: 'Undo' })).toBeNull();
    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(UNDONE_MESSAGE)).toBeInTheDocument();
    expect(reverts).toEqual([{ ifMatch: '2', body: { changeLogId: 'cl-3' } }]);
    expect(await within(log).findByTestId('reverted-marker')).toBeInTheDocument();
  });

  it('decides an open proposal through its run (E5.8)', async () => {
    const proposal: ChangeLogEntry = { ...mockChangeLog[1], id: 'cl-p', kind: 'adapted', status: 'proposed', toVersion: null, runId: RUN_ID };
    const decisions: unknown[] = [];
    serveHistory();
    server.use(
      http.get(`*/api/programs/${PROGRAM_ID}/change-log`, () =>
        HttpResponse.json({ data: { items: decisions.length ? [{ ...proposal, status: 'applied', toVersion: 3 }] : [proposal], nextCursor: null } }),
      ),
      http.post(`*/api/ai/training/runs/${RUN_ID}/decision`, async ({ request }) => {
        decisions.push(await request.json());
        return HttpResponse.json({ data: { id: RUN_ID } }, { status: 202 });
      }),
    );
    render(
      <Routes>
        <Route path="/train/plans/:programId/history" element={<PlanHistoryPage />} />
      </Routes>,
      { wrapperOptions: { route: `/train/plans/${PROGRAM_ID}/history`, aiEnabled: true, user } },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. Your plan is being updated.')).toBeInTheDocument();
    expect(decisions).toEqual([{ decision: 'approve' }]);
  });

  it('has no axe violations', async () => {
    serveHistory();
    const { container } = renderHistory();
    await screen.findByTestId('diff-summary');
    await screen.findAllByTestId('change-log-entry');
    expect(await axe(container)).toHaveNoViolations();
  });
});
