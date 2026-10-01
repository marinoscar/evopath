/**
 * One biomarker (H5, #189) against MSW: the trend chart, the results table
 * (cards below `sm`), the source report link ("View report" through a
 * short-lived signed URL, "File deleted", "Document unavailable" on a 404),
 * the revision history dialog, an unknown analyte, and axe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, render, screen, waitFor, within } from '../utils/test-utils';
import { server } from '../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../setup';
import BiomarkerDetailPage from '../../pages/BiomarkerDetailPage';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';
import {
  DOCUMENT_UNAVAILABLE_LABEL,
  FILE_DELETED_LABEL,
} from '../../components/health/biomarkers/SourceDocumentLink';
import { REVISION_HISTORY_TITLE } from '../../components/health/biomarkers/RevisionHistoryDialog';
import { mockLabCatalog } from '../mocks/fixtures/labReportIntake';
import {
  KEPT_DOCUMENT_ID,
  MISSING_DOCUMENT_ID,
  mockDocumentDownload,
  mockLdlResults,
  mockLdlRevisions,
  mockLdlSeries,
} from '../mocks/fixtures/biomarkers';

interface Calls {
  series: URLSearchParams[];
  list: URLSearchParams[];
  revisions: string[];
  downloads: string[];
}

function detailApi(options: { results?: typeof mockLdlResults; totalPages?: number } = {}): Calls {
  const calls: Calls = { series: [], list: [], revisions: [], downloads: [] };
  const results = options.results ?? mockLdlResults;
  server.use(
    http.get('*/api/measurements/metrics', () => HttpResponse.json({ data: mockLabCatalog })),
    http.get('*/api/measurements/series', ({ request }) => {
      calls.series.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: mockLdlSeries });
    }),
    http.get('*/api/measurements', ({ request }) => {
      const params = new URL(request.url).searchParams;
      calls.list.push(params);
      const page = Number(params.get('page') ?? '1');
      return HttpResponse.json({
        data: {
          items: results,
          total: results.length,
          page,
          pageSize: Number(params.get('pageSize')),
          totalPages: options.totalPages ?? 1,
        },
      });
    }),
    http.get('*/api/measurements/:id/revisions', ({ params }) => {
      calls.revisions.push(String(params.id));
      return HttpResponse.json({ data: { items: mockLdlRevisions } });
    }),
    http.get('*/api/health/documents/:id/download', ({ params, request }) => {
      calls.downloads.push(`${String(params.id)}?${new URL(request.url).searchParams}`);
      if (params.id === MISSING_DOCUMENT_ID) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
      }
      return HttpResponse.json({ data: mockDocumentDownload });
    }),
  );
  return calls;
}

function renderDetail(analyteKey = 'ldl_cholesterol') {
  const user = userEvent.setup();
  const utils = render(
    <Routes>
      <Route path="/health/biomarkers/:analyteKey" element={<BiomarkerDetailPage />} />
    </Routes>,
    { wrapperOptions: { route: `/health/biomarkers/${analyteKey}` } },
  );
  return { ...utils, user };
}

beforeEach(() => resetMeasurementCatalogCache());
afterEach(() => {
  act(() => resetViewportWidth());
  vi.restoreAllMocks();
});

describe('BiomarkerDetailPage', () => {
  it('shows the trend and every result with its range, flag, origin and source', async () => {
    const calls = detailApi();
    const { container } = renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'LDL cholesterol' })).toBeInTheDocument();
    expect(screen.getByText('Lipids · Shown in mg/dL, the standard unit for this test.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Biomarkers' })).toHaveAttribute('href', '/health/biomarkers');

    expect(await screen.findByRole('img', { name: /^LDL cholesterol, 4 results, latest 142\.0 mg\/dL/ })).toBeInTheDocument();
    expect(screen.getByText(/labs can print different ranges/)).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'LDL cholesterol results' });
    const rows = within(table).getAllByTestId('biomarker-result');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Sep 15, 2026');
    expect(rows[0]).toHaveTextContent('142.0');
    expect(rows[0]).toHaveTextContent('≤ 100');
    expect(rows[0]).toHaveTextContent('Flag: High');
    expect(rows[0]).toHaveTextContent('Read from report');
    expect(within(rows[0]).getByText('Edited')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: /^View report for LDL cholesterol result from Sep 15, 2026/ })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('0–130');
    expect(within(rows[1]).getByText(FILE_DELETED_LABEL)).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: /View report/ })).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Entered by you');
    expect(within(rows[2]).queryByRole('button', { name: /View report/ })).not.toBeInTheDocument();

    // Every value the API keeps: the five-year window, and a lab key on the list.
    const from = new Date(calls.series[0].get('from')!);
    expect(calls.series[0].get('metricKey')).toBe('ldl_cholesterol');
    expect(Date.now() - from.getTime()).toBeGreaterThan(4.9 * 365 * 24 * 3600 * 1000);
    expect(calls.list[0].get('metricKey')).toBe('ldl_cholesterol');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('opens a kept report through the signed URL in a new tab', async () => {
    const calls = detailApi();
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: /^View report for LDL cholesterol result from Sep 15, 2026/ }));
    await waitFor(() => expect(tab.location.href).toBe(mockDocumentDownload.url));
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(calls.downloads).toEqual([`${KEPT_DOCUMENT_ID}?disposition=inline`]);
    // The signed URL never reaches the page.
    expect(document.body.innerHTML).not.toContain(mockDocumentDownload.url);
  });

  it('reads Document unavailable when the document is gone', async () => {
    detailApi({
      results: [{ ...mockLdlResults[0], sourceRef: { kind: 'lab_report', healthDocumentId: MISSING_DOCUMENT_ID } }],
    });
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: /^View report/ }));
    expect(await screen.findByText(DOCUMENT_UNAVAILABLE_LABEL)).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });

  it('a value opens its revision history, newest first', async () => {
    const calls = detailApi();
    const { user } = renderDetail();

    await user.click(
      await screen.findByRole('button', { name: 'LDL cholesterol 142.0 mg/dL on Sep 15, 2026: show value history' }),
    );
    const dialog = await screen.findByRole('dialog', { name: new RegExp(`^${REVISION_HISTORY_TITLE}`) });
    const items = await within(dialog).findAllByTestId('revision-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('142.0 mg/dL');
    expect(items[0]).toHaveTextContent('Current');
    expect(items[1]).toHaveTextContent('124.0 mg/dL');
    expect(items[1]).toHaveTextContent('Revision 1');
    expect(items[1]).toHaveTextContent('Replaced Sep 16, 2026');
    expect(within(dialog).getByText(/Edited 1 time\./)).toBeInTheDocument();
    expect(calls.revisions).toEqual([mockLdlResults[0].id]);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('pages through the results', async () => {
    const calls = detailApi({ totalPages: 2 });
    const { user } = renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Results page 2' }));
    await waitFor(() => expect(calls.list.at(-1)?.get('page')).toBe('2'));
  });

  it('below sm the results are cards, not a table', async () => {
    act(() => setViewportWidth(390));
    detailApi();
    const { container } = renderDetail();

    const list = await screen.findByRole('list', { name: 'LDL cholesterol results' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = within(list).getAllByTestId('biomarker-result');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('Range ≤ 100');
    expect(within(cards[1]).getByText(FILE_DELETED_LABEL)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an analyte that is not in the lab catalog is not found, and nothing is fetched for it', async () => {
    const calls = detailApi();
    renderDetail('weight');
    expect(await screen.findByRole('heading', { level: 1, name: 'Biomarker not found' })).toBeInTheDocument();
    expect(calls.series).toHaveLength(0);
    expect(calls.list).toHaveLength(0);
  });
});
