/**
 * The source of one lab result, H5 (#189): the report it was read from.
 *
 * - `fileDeleted === true`: the user chose "delete after processing" (H1), so
 *   the values stayed and the file is gone: **File deleted**, no link.
 * - A `sourceRef.healthDocumentId` otherwise: **View report**. A click asks
 *   the documents API for a short-lived signed URL
 *   (`GET /api/health/documents/:id/download?disposition=inline`) and opens it
 *   in a new tab. The URL is a bearer credential for its lifetime: it is never
 *   stored, logged or put in the DOM. The tab is opened synchronously (inside
 *   the click, so no popup blocker stops it) and pointed at the URL once it
 *   arrives. A `404` (the document was removed since) reads
 *   **Document unavailable**.
 * - No document: nothing (a result typed in by hand has no source file).
 */
import { useState } from 'react';
import { Button, Chip, Typography } from '@mui/material';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HideSourceOutlinedIcon from '@mui/icons-material/HideSourceOutlined';
import {
  getHealthDocumentDownloadUrl,
  isNotFound,
  sourceDocumentId,
  type LabMeasurement,
} from '../../../services/biomarkers';

export const FILE_DELETED_LABEL = 'File deleted';
export const DOCUMENT_UNAVAILABLE_LABEL = 'Document unavailable';
export const VIEW_REPORT_LABEL = 'View report';

export interface SourceDocumentLinkProps {
  row: Pick<LabMeasurement, 'sourceRef' | 'fileDeleted'>;
  /** Words for the button's accessible name, e.g. "LDL cholesterol result from Sep 15, 2026". */
  describedAs: string;
}

export function SourceDocumentLink({ row, describedAs }: SourceDocumentLinkProps) {
  const [state, setState] = useState<'idle' | 'opening' | 'unavailable' | 'error'>('idle');
  const documentId = sourceDocumentId(row);

  if (row.fileDeleted === true) {
    return (
      <Chip
        size="small"
        variant="outlined"
        icon={<HideSourceOutlinedIcon />}
        label={FILE_DELETED_LABEL}
        title="The report was erased after its values were saved"
      />
    );
  }
  if (!documentId) {
    return (
      <Typography variant="body2" color="text.secondary" component="span">
        —
      </Typography>
    );
  }
  if (state === 'unavailable') {
    return (
      <Typography variant="body2" color="text.secondary" component="span">
        {DOCUMENT_UNAVAILABLE_LABEL}
      </Typography>
    );
  }

  const open = async () => {
    // Opened inside the click so a popup blocker allows it; pointed at the URL below.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setState('opening');
    try {
      const { url } = await getHealthDocumentDownloadUrl(documentId);
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
      setState('idle');
    } catch (err) {
      tab?.close();
      setState(isNotFound(err) ? 'unavailable' : 'error');
    }
  };

  return (
    <>
      <Button
        size="small"
        startIcon={<DescriptionOutlinedIcon />}
        onClick={() => void open()}
        disabled={state === 'opening'}
        aria-label={`${VIEW_REPORT_LABEL} for ${describedAs} (opens in a new tab)`}
        sx={{ minHeight: 32, whiteSpace: 'nowrap' }}
      >
        {VIEW_REPORT_LABEL}
      </Button>
      {state === 'error' && (
        <Typography variant="caption" color="error" role="alert" sx={{ display: 'block' }}>
          Could not open the report. Try again.
        </Typography>
      )}
    </>
  );
}

export default SourceDocumentLink;
