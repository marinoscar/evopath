/**
 * `UserHealthDocumentsPage` (issue #190, H6) against MSW: the real page, hook,
 * services and DataTable, so every request the page sends (query params,
 * `If-Match`, `deleteValues`, `disposition`) is asserted on the wire.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render, mockUser, type MockUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import UserHealthDocumentsPage, {
  READ_ONLY_REASON,
  STALE_MESSAGE,
} from '../../pages/UserHealthDocumentsPage';
import {
  mockDeletedFile,
  mockDeletionPending,
  mockHealthDocumentList,
  mockLabReportPdf,
  mockScalePhoto,
} from '../mocks/fixtures/healthDocuments';
import type { HealthDocument } from '../../services/healthDocuments';

const SIGNED = 'https://storage.example.test/signed/object?sig=abc';

const readOnlyUser: MockUser = {
  ...mockUser,
  permissions: mockUser.permissions.filter((p) => p !== 'health_data:write'),
};

const rowLabel = (doc: HealthDocument) => `${doc.originalName} (${doc.id.slice(0, 8)})`;

/** Serve `items` and record every list request's query string. */
function serveList(items: HealthDocument[], total = items.length) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get('*/api/health/documents', ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: mockHealthDocumentList(items, total) });
    })
  );
  return queries;
}

function renderPage(user: MockUser = mockUser, width = 1400) {
  setInitialContainerWidth(width);
  return render(<UserHealthDocumentsPage />, { wrapperOptions: { user } });
}

async function openRowMenu(u: ReturnType<typeof userEvent.setup>, doc: HealthDocument) {
  await u.click(await screen.findByRole('button', { name: `Row actions for ${rowLabel(doc)}` }));
  return screen.findByRole('menu');
}

describe('UserHealthDocumentsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    resetContainerWidth(1400);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the title, description and one row per document with its facts', async () => {
    serveList([mockLabReportPdf, mockScalePhoto, mockDeletedFile, mockDeletionPending]);
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Health Documents' })).toBeInTheDocument();
    expect(
      screen.getByText(/View, download, rename and delete the photos and reports/)
    ).toBeInTheDocument();

    const pdfRow = (await screen.findByText('lipid-panel.pdf')).closest(
      '[role="row"]'
    ) as HTMLElement;
    expect(pdfRow).toHaveTextContent('Lab report');
    expect(pdfRow).toHaveTextContent('PDF');
    expect(pdfRow).toHaveTextContent('1.4 MB');
    expect(pdfRow).toHaveTextContent('Available');

    const photoRow = screen.getByText('scale.jpg').closest('[role="row"]') as HTMLElement;
    expect(photoRow).toHaveTextContent('Body metrics');
    expect(photoRow).toHaveTextContent('JPEG image');
    expect(photoRow).toHaveTextContent('820 B');
    expect(photoRow).toHaveTextContent('Not set');

    expect(screen.getByText(/^File deleted on /)).toBeInTheDocument();
    expect(screen.getByText('Deleting…')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    serveList([mockLabReportPdf, mockDeletedFile]);
    const { container } = renderPage();
    await screen.findByText('lipid-panel.pdf');
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
  });

  it('shows an empty state when there are no documents', async () => {
    serveList([]);
    renderPage();
    expect(await screen.findByText(/No health documents yet/)).toBeInTheDocument();
  });

  it('shows the load error inline', async () => {
    server.use(
      http.get('*/api/health/documents', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 })
      )
    );
    renderPage();
    expect(await screen.findByText('Insufficient permissions')).toBeInTheDocument();
  });

  it('asks for page 1 of 25, newest uploads first by default', async () => {
    const queries = serveList([mockLabReportPdf]);
    renderPage();
    await screen.findByText('lipid-panel.pdf');
    expect(queries[0].get('page')).toBe('1');
    expect(queries[0].get('pageSize')).toBe('25');
    expect(queries[0].get('sort')).toBeNull();
    expect(queries[0].get('kind')).toBeNull();
  });

  it('maps the Kind filter onto ?kind=', async () => {
    const queries = serveList([mockLabReportPdf]);
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('lipid-panel.pdf');

    await u.click(screen.getByRole('combobox', { name: 'Value' }));
    await u.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'Lab report' })
    );
    await u.click(screen.getByTestId('datatable-filter-apply'));

    await waitFor(() => expect(queries.at(-1)?.get('kind')).toBe('lab_report'));
    expect(queries.at(-1)?.get('page')).toBe('1');
  });

  it('sorts by upload date and by document date through the column headers', async () => {
    const queries = serveList([mockLabReportPdf]);
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('lipid-panel.pdf');

    await u.click(screen.getByRole('columnheader', { name: /^Document date/ }));
    await waitFor(() => expect(queries.at(-1)?.get('sort')).toBe('documentDate'));
    expect(queries.at(-1)?.get('order')).toBe('asc');

    await u.click(screen.getByRole('columnheader', { name: /^Uploaded/ }));
    await waitFor(() => expect(queries.at(-1)?.get('sort')).toBe('createdAt'));
  });

  it('pages through the server', async () => {
    const queries = serveList([mockLabReportPdf], 30);
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('lipid-panel.pdf');

    await u.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => expect(queries.at(-1)?.get('page')).toBe('2'));
  });

  describe('view', () => {
    it('shows a PDF in an iframe of the signed inline URL, with a new-tab fallback', async () => {
      serveList([mockLabReportPdf]);
      let disposition: string | null = null;
      server.use(
        http.get('*/api/health/documents/:id/download', ({ request, params }) => {
          expect(params.id).toBe(mockLabReportPdf.id);
          disposition = new URL(request.url).searchParams.get('disposition');
          return HttpResponse.json({
            data: {
              url: SIGNED,
              expiresIn: 300,
              expiresAt: '2026-10-01T00:05:00.000Z',
              disposition: 'inline',
              fileName: 'lipid-panel.pdf',
              mimeType: 'application/pdf',
            },
          });
        })
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'View' })
      );

      const dialog = await screen.findByRole('dialog', { name: 'lipid-panel.pdf' });
      const frame = await within(dialog).findByTitle('Preview of lipid-panel.pdf');
      expect(frame.tagName).toBe('IFRAME');
      expect(frame).toHaveAttribute('src', SIGNED);
      expect(disposition).toBe('inline');
      const link = within(dialog).getByRole('link', { name: 'Open in a new tab' });
      expect(link).toHaveAttribute('href', SIGNED);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');

      await u.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('shows an image in an img with the file name as its alt text', async () => {
      serveList([mockScalePhoto]);
      server.use(
        http.get('*/api/health/documents/:id/download', () =>
          HttpResponse.json({
            data: {
              url: SIGNED,
              expiresIn: 300,
              expiresAt: '2026-10-01T00:05:00.000Z',
              disposition: 'inline',
              fileName: 'scale.jpg',
              mimeType: 'image/jpeg',
            },
          })
        )
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockScalePhoto)).getByRole('menuitem', { name: 'View' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'scale.jpg' });
      expect(await within(dialog).findByRole('img', { name: 'scale.jpg' })).toHaveAttribute(
        'src',
        SIGNED
      );
    });

    it('explains a refused download (409) in the dialog', async () => {
      serveList([mockLabReportPdf]);
      server.use(
        http.get('*/api/health/documents/:id/download', () =>
          HttpResponse.json(
            {
              message: 'Conflict',
              code: 'CONFLICT',
              details: { reason: 'HEALTH_DOCUMENT_FILE_DELETION_PENDING' },
            },
            { status: 409 }
          )
        )
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'View' })
      );
      expect(await screen.findByText('This file is being deleted.')).toBeInTheDocument();
    });

    it('disables View and Download, with the reason, for a deleted or deleting file', async () => {
      serveList([mockDeletedFile, mockDeletionPending]);
      const u = userEvent.setup();
      renderPage();

      let menu = await openRowMenu(u, mockDeletedFile);
      for (const name of ['View', 'Download']) {
        const item = within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) });
        expect(item).toHaveAttribute('aria-disabled', 'true');
        expect(item).toHaveTextContent('The file was deleted.');
      }
      // Delete stays available: a metadata-only row can be removed.
      expect(within(menu).getByRole('menuitem', { name: 'Delete' })).not.toHaveAttribute(
        'aria-disabled'
      );
      await u.keyboard('{Escape}');

      menu = await openRowMenu(u, mockDeletionPending);
      expect(within(menu).getByRole('menuitem', { name: /^View/ })).toHaveTextContent(
        'The file is being deleted.'
      );
    });
  });

  describe('download', () => {
    it('asks for an attachment URL and hands it to the browser', async () => {
      serveList([mockLabReportPdf]);
      let disposition: string | null = null;
      server.use(
        http.get('*/api/health/documents/:id/download', ({ request }) => {
          disposition = new URL(request.url).searchParams.get('disposition');
          return HttpResponse.json({
            data: {
              url: SIGNED,
              expiresIn: 300,
              expiresAt: '2026-10-01T00:05:00.000Z',
              disposition: 'attachment',
              fileName: 'lipid-panel.pdf',
              mimeType: 'application/pdf',
            },
          });
        })
      );
      const clicked: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement
      ) {
        clicked.push(this.href);
      });
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'Download' })
      );

      await waitFor(() => expect(clicked).toEqual([SIGNED]));
      expect(disposition).toBe('attachment');
      expect(await screen.findByText('Download started.')).toBeInTheDocument();
    });

    it('says why a download was refused', async () => {
      serveList([mockLabReportPdf]);
      server.use(
        http.get('*/api/health/documents/:id/download', () =>
          HttpResponse.json(
            { message: 'Conflict', details: { reason: 'HEALTH_DOCUMENT_FILE_DELETED' } },
            { status: 409 }
          )
        )
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'Download' })
      );
      expect(await screen.findByText('This file has been deleted.')).toBeInTheDocument();
    });
  });

  describe('rename or set date', () => {
    it('PATCHes only what changed, with If-Match, then refreshes', async () => {
      const queries = serveList([mockLabReportPdf]);
      let body: unknown = null;
      let ifMatch: string | null = null;
      server.use(
        http.patch('*/api/health/documents/:id', async ({ request }) => {
          body = await request.json();
          ifMatch = request.headers.get('If-Match');
          return HttpResponse.json({ data: { ...mockLabReportPdf, version: 4 } });
        })
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', {
          name: 'Rename or set date',
        })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Rename or set date' });
      const name = within(dialog).getByRole('textbox', { name: /Name/ });
      expect(name).toHaveValue('lipid-panel.pdf');
      await u.clear(name);
      await u.type(name, 'Lipids September.pdf');
      fireEvent.change(within(dialog).getByLabelText('Document date'), {
        target: { value: '2026-09-14' },
      });
      const before = queries.length;
      await u.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Document updated.')).toBeInTheDocument();
      expect(ifMatch).toBe('3');
      expect(body).toEqual({ originalName: 'Lipids September.pdf', documentDate: '2026-09-14' });
      await waitFor(() => expect(queries.length).toBeGreaterThan(before));
    });

    it('clears the document date with null', async () => {
      serveList([mockLabReportPdf]);
      let body: unknown = null;
      server.use(
        http.patch('*/api/health/documents/:id', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            data: { ...mockLabReportPdf, documentDate: null, version: 4 },
          });
        })
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', {
          name: 'Rename or set date',
        })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Rename or set date' });
      fireEvent.change(within(dialog).getByLabelText('Document date'), { target: { value: '' } });
      await u.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(body).toEqual({ documentDate: null }));
    });

    it('refuses an empty name before the round trip', async () => {
      serveList([mockLabReportPdf]);
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', {
          name: 'Rename or set date',
        })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Rename or set date' });
      await u.clear(within(dialog).getByRole('textbox', { name: /Name/ }));
      expect(within(dialog).getByText('Enter a name.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('on 412 closes, refreshes the list and says the document changed', async () => {
      const queries = serveList([mockLabReportPdf]);
      server.use(
        http.patch('*/api/health/documents/:id', () =>
          HttpResponse.json(
            {
              message: 'Precondition failed',
              code: 'PRECONDITION_FAILED',
              details: { reason: 'HEALTH_DOCUMENT_STALE', currentVersion: 5 },
            },
            { status: 412 }
          )
        )
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', {
          name: 'Rename or set date',
        })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Rename or set date' });
      await u.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'x');
      const before = queries.length;
      await u.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText(STALE_MESSAGE)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Rename or set date' })).not.toBeInTheDocument()
      );
      await waitFor(() => expect(queries.length).toBeGreaterThan(before));
    });
  });

  describe('delete', () => {
    function captureDelete() {
      const calls: { deleteValues: string | null; ifMatch: string | null; id: string }[] = [];
      server.use(
        http.delete('*/api/health/documents/:id', ({ request, params }) => {
          calls.push({
            id: String(params.id),
            deleteValues: new URL(request.url).searchParams.get('deleteValues'),
            ifMatch: request.headers.get('If-Match'),
          });
          return HttpResponse.json({
            data: { id: params.id, scope: 'file', jobId: 'job-1', valuesDeleted: 0 },
          });
        })
      );
      return calls;
    }

    it('keeps the extracted values unless the box is ticked', async () => {
      serveList([mockLabReportPdf]);
      const calls = captureDelete();
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'Delete' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Delete this file?' });
      const box = within(dialog).getByRole('checkbox', {
        name: 'Also delete the 4 values extracted from this document',
      });
      expect(box).not.toBeChecked();
      await u.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() =>
        expect(calls).toEqual([{ id: mockLabReportPdf.id, deleteValues: 'false', ifMatch: '3' }])
      );
      expect(await screen.findByText('The file is being deleted.')).toBeInTheDocument();
    });

    it('sends deleteValues=true when the box is ticked', async () => {
      serveList([mockLabReportPdf]);
      const calls = captureDelete();
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'Delete' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Delete this file?' });
      expect(await axe(dialog)).toHaveNoViolations();
      await u.click(within(dialog).getByRole('checkbox'));
      await u.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(calls[0]?.deleteValues).toBe('true'));
    });

    it('hides the checkbox when nothing was extracted', async () => {
      serveList([mockScalePhoto]);
      captureDelete();
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockScalePhoto)).getByRole('menuitem', { name: 'Delete' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Delete this file?' });
      expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('removes a metadata-only record whose file is already gone', async () => {
      serveList([mockDeletedFile]);
      const calls = captureDelete();
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockDeletedFile)).getByRole('menuitem', { name: 'Delete' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Remove this record?' });
      expect(dialog).toHaveTextContent('was already deleted');
      await u.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(calls[0]).toMatchObject({ id: mockDeletedFile.id, ifMatch: '2' }));
    });

    it('on 412 refreshes and says the document changed', async () => {
      const queries = serveList([mockLabReportPdf]);
      server.use(
        http.delete('*/api/health/documents/:id', () =>
          HttpResponse.json(
            {
              message: 'Precondition failed',
              details: { reason: 'HEALTH_DOCUMENT_STALE', currentVersion: 4 },
            },
            { status: 412 }
          )
        )
      );
      const u = userEvent.setup();
      renderPage();

      await u.click(
        within(await openRowMenu(u, mockLabReportPdf)).getByRole('menuitem', { name: 'Delete' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Delete this file?' });
      const before = queries.length;
      await u.click(within(dialog).getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(STALE_MESSAGE)).toBeInTheDocument();
      await waitFor(() => expect(queries.length).toBeGreaterThan(before));
    });
  });

  it('disables rename and delete, with the reason, without health_data:write', async () => {
    serveList([mockLabReportPdf]);
    const u = userEvent.setup();
    renderPage(readOnlyUser);

    expect(await screen.findByText(/Renaming and deleting need permission/)).toBeInTheDocument();
    const menu = await openRowMenu(u, mockLabReportPdf);
    for (const name of ['Rename or set date', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent(READ_ONLY_REASON);
    }
    expect(within(menu).getByRole('menuitem', { name: 'View' })).not.toHaveAttribute(
      'aria-disabled'
    );
    expect(within(menu).getByRole('menuitem', { name: 'Download' })).not.toHaveAttribute(
      'aria-disabled'
    );
  });

  it('renders cards, not a grid, at phone width', async () => {
    serveList([mockLabReportPdf, mockDeletedFile]);
    const u = userEvent.setup();
    const { container } = renderPage(mockUser, 375);

    await screen.findByText('lipid-panel.pdf');
    expect(screen.getByTestId('health-documents-table')).toHaveAttribute('data-layout', 'mobile');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('datatable-card')).toHaveLength(2);

    const menu = await openRowMenu(u, mockLabReportPdf);
    expect(within(menu).getByRole('menuitem', { name: 'View' })).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
  });
});
