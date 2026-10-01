/**
 * Settings → Health Documents (`/settings/health-documents`), issue #190 (H6).
 *
 * Every file the system holds about the caller's health, one place to view,
 * download, rename, date and delete it. A `DataTable`: a grid at desktop and
 * tablet widths and a card list below `sm`, with the kind filter, the
 * document/upload date sort and pagination all answered by the server.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('health_data:read')`, the exact string the documents
 * controller's reads enforce and the card in `config/userSettingsSections.tsx`
 * declares. Rename and delete are gated here on `health_data:write`, disabled
 * with the reason rather than hidden; the API enforces both either way.
 *
 * Signed URLs (view, download) are fetched per click and held in state only.
 */

import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Container, Snackbar, Typography } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { DataTable } from '../components/datatable';
import type {
  DataTableFilterModel,
  DataTableRowAction,
  DataTableSortState,
} from '../components/datatable';
import { usePermissions } from '../hooks/usePermissions';
import { useHealthDocuments } from '../hooks/useHealthDocuments';
import {
  downloadErrorMessage,
  getHealthDocumentDownload,
  type HealthDocument,
  type HealthDocumentDeleteResult,
  type HealthDocumentKind,
} from '../services/healthDocuments';
import {
  TABLE_ID,
  asHealthDocumentSortField,
  buildHealthDocumentColumns,
  isHealthDocumentKind,
} from '../components/settings/healthDocuments/healthDocumentColumns';
import { HealthDocumentViewerDialog } from '../components/settings/healthDocuments/HealthDocumentViewerDialog';
import { HealthDocumentEditDialog } from '../components/settings/healthDocuments/HealthDocumentEditDialog';
import { HealthDocumentDeleteDialog } from '../components/settings/healthDocuments/HealthDocumentDeleteDialog';

export const HEALTH_DOCUMENTS_TITLE = 'Health Documents';
export const HEALTH_DOCUMENTS_DESCRIPTION =
  'View, download, rename and delete the photos and reports you uploaded for your health record.';
export const STALE_MESSAGE =
  'This document changed since you opened it. The list was refreshed; check it and try again.';
export const READ_ONLY_REASON = 'You need permission to change health data.';

/** The `kind` query param, read out of the filter model as a scalar. */
function readKindFilter(filters: DataTableFilterModel): HealthDocumentKind | undefined {
  const found = filters.find((filter) => filter.columnId === 'kind' && filter.operator === 'is');
  return isHealthDocumentKind(found?.value) ? found.value : undefined;
}

/** Hand a signed `attachment` URL to the browser's own download machinery. */
function startDownload(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function deletedMessage(result: HealthDocumentDeleteResult): string {
  const base = result.scope === 'file' ? 'The file is being deleted.' : 'The record was removed.';
  if (result.valuesDeleted === 0) return base;
  return `${base} ${result.valuesDeleted === 1 ? '1 value was' : `${result.valuesDeleted} values were`} deleted too.`;
}

export default function UserHealthDocumentsPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('health_data:write');

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<DataTableSortState | null>(null);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  const kind = useMemo(() => readKindFilter(filters), [filters]);
  const sortField = asHealthDocumentSortField(sort?.field);

  const { documents, total, isLoading, error, refresh } = useHealthDocuments({
    kind,
    sort: sortField,
    order: sortField ? sort?.direction : undefined,
    page: page + 1,
    pageSize,
  });

  const [viewing, setViewing] = useState<HealthDocument | null>(null);
  const [editing, setEditing] = useState<HealthDocument | null>(null);
  const [deleting, setDeleting] = useState<HealthDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const columns = useMemo(() => buildHealthDocumentColumns(), []);

  const handleDownload = useCallback(async (doc: HealthDocument) => {
    try {
      const link = await getHealthDocumentDownload(doc.id, 'attachment');
      startDownload(link.url);
      setNotice('Download started.');
    } catch (err) {
      setFailure(downloadErrorMessage(err));
    }
  }, []);

  const handleStale = useCallback(() => {
    setEditing(null);
    setDeleting(null);
    setFailure(STALE_MESSAGE);
    void refresh();
  }, [refresh]);

  const rowActions = useMemo(() => {
    const noFile = (doc: HealthDocument) => !doc.fileAvailable || doc.fileDeletionPending;
    const noFileReason = (doc: HealthDocument) =>
      doc.fileDeletionPending ? 'The file is being deleted.' : 'The file was deleted.';
    return [
      {
        id: 'view',
        label: 'View',
        icon: <VisibilityIcon fontSize="small" />,
        disabled: noFile,
        disabledReason: noFileReason,
        onClick: (doc) => setViewing(doc),
      },
      {
        id: 'download',
        label: 'Download',
        icon: <DownloadIcon fontSize="small" />,
        disabled: noFile,
        disabledReason: noFileReason,
        onClick: (doc) => void handleDownload(doc),
      },
      {
        id: 'edit',
        label: 'Rename or set date',
        icon: <EditIcon fontSize="small" />,
        disabled: () => !canWrite,
        disabledReason: () => READ_ONLY_REASON,
        onClick: (doc) => setEditing(doc),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // A row whose file is already gone can still be removed: that is how
        // the user clears metadata-only history.
        disabled: () => !canWrite,
        disabledReason: () => READ_ONLY_REASON,
        onClick: (doc) => setDeleting(doc),
      },
    ] satisfies DataTableRowAction<HealthDocument>[];
  }, [canWrite, handleDownload]);

  const emptyState = (
    <Typography variant="body2" color="text.secondary">
      {kind
        ? 'No documents of this kind.'
        : 'No health documents yet. Photos and reports you keep when reading your measurements appear here.'}
    </Typography>
  );

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {HEALTH_DOCUMENTS_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {HEALTH_DOCUMENTS_DESCRIPTION}
        </Typography>

        {!canWrite && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can view and download your documents. Renaming and deleting need permission to
            change health data.
          </Alert>
        )}

        <DataTable<HealthDocument>
          tableId={TABLE_ID}
          data-testid="health-documents-table"
          ariaLabel="Health documents"
          density="compact"
          columns={columns}
          rows={documents}
          rowId={(doc) => doc.id}
          loading={isLoading}
          error={error}
          emptyState={emptyState}
          pagination={{
            page,
            pageSize,
            total,
            pageSizeOptions: [10, 25, 50, 100],
            onPaginationChange: (next) => {
              setPage(next.page);
              setPageSize(next.pageSize);
            },
          }}
          sort={{
            sort,
            onSortChange: (next) => {
              setSort(next);
              setPage(0);
            },
          }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            setPage(0);
          }}
          rowActions={rowActions}
          // A CSV of health file names is a file that outlives the session for
          // no task this page serves.
          disableExport
        />
      </Box>

      <HealthDocumentViewerDialog document={viewing} onClose={() => setViewing(null)} />

      <HealthDocumentEditDialog
        document={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setNotice('Document updated.');
          void refresh();
        }}
        onStale={handleStale}
      />

      <HealthDocumentDeleteDialog
        document={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(result) => {
          setDeleting(null);
          setNotice(deletedMessage(result));
          void refresh();
        }}
        onStale={handleStale}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        message={notice}
      />
      <Snackbar open={failure !== null} autoHideDuration={8000} onClose={() => setFailure(null)}>
        <Alert severity="error" onClose={() => setFailure(null)}>
          {failure}
        </Alert>
      </Snackbar>
    </Container>
  );
}
