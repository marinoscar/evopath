/**
 * `useHealthDocuments` (#190, H6) against MSW: the query it sends, refetch on
 * a param change, and that a slow answer for an older query never overwrites
 * the newer one.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useHealthDocuments } from '../../hooks/useHealthDocuments';
import type { ListHealthDocumentsParams } from '../../services/healthDocuments';
import {
  mockHealthDocumentList,
  mockLabReportPdf,
  mockScalePhoto,
} from '../mocks/fixtures/healthDocuments';

describe('useHealthDocuments', () => {
  it('loads a page and sends only the params it was given', async () => {
    let query = '';
    server.use(
      http.get('*/api/health/documents', ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ data: mockHealthDocumentList([mockLabReportPdf], 7) });
      })
    );
    const { result } = renderHook(() =>
      useHealthDocuments({
        kind: 'lab_report',
        sort: 'documentDate',
        order: 'asc',
        page: 2,
        pageSize: 5,
      })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.documents).toEqual([mockLabReportPdf]);
    expect(result.current.total).toBe(7);
    expect(query).toBe('?kind=lab_report&sort=documentDate&order=asc&page=2&pageSize=5');
  });

  it('keeps the newest query when an older answer arrives late', async () => {
    server.use(
      http.get('*/api/health/documents', async ({ request }) => {
        const kind = new URL(request.url).searchParams.get('kind');
        if (kind === null) {
          await delay(150);
          return HttpResponse.json({ data: mockHealthDocumentList([mockScalePhoto]) });
        }
        return HttpResponse.json({ data: mockHealthDocumentList([mockLabReportPdf]) });
      })
    );
    const { result, rerender } = renderHook(
      (params: ListHealthDocumentsParams) => useHealthDocuments(params),
      {
        initialProps: { page: 1 },
      }
    );
    rerender({ page: 1, kind: 'lab_report' });

    await waitFor(() => expect(result.current.documents).toEqual([mockLabReportPdf]));
    await act(() => delay(200));
    expect(result.current.documents).toEqual([mockLabReportPdf]);
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a load error', async () => {
    server.use(
      http.get('*/api/health/documents', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 })
      )
    );
    const { result } = renderHook(() => useHealthDocuments({ page: 1 }));
    await waitFor(() => expect(result.current.error).toBe('Insufficient permissions'));
  });
});
