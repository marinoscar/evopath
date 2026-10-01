/**
 * The inline viewer for one health document (issue #190, H6).
 *
 * The signed `inline` URL is fetched when the dialog opens and lives in this
 * component's state only: it is a bearer credential for its 300 seconds. A PDF
 * is drawn in an `<iframe>`, a raster image in an `<img>`; anything else, or a
 * preview the browser refuses (a storage host the page's CSP does not allow
 * framing, a PDF viewer turned off), falls back to "Open in a new tab", which
 * is always offered once the URL is known.
 */

import { useEffect, useId, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  downloadErrorMessage,
  getHealthDocumentDownload,
  type HealthDocument,
} from '../../../services/healthDocuments';
import { viewerKind } from './healthDocumentColumns';

export interface HealthDocumentViewerDialogProps {
  document: HealthDocument | null;
  onClose: () => void;
}

export function HealthDocumentViewerDialog({ document: doc, onClose }: HealthDocumentViewerDialogProps) {
  const titleId = useId();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const docId = doc?.id ?? null;
  useEffect(() => {
    setUrl(null);
    setError(null);
    setImageFailed(false);
    if (!docId) return;
    let cancelled = false;
    getHealthDocumentDownload(docId, 'inline').then(
      (link) => {
        if (!cancelled) setUrl(link.url);
      },
      (err: unknown) => {
        if (!cancelled) setError(downloadErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const kind = doc ? viewerKind(doc.mimeType) : null;
  const name = doc?.originalName ?? '';

  let body;
  if (error) {
    body = <Alert severity="error">{error}</Alert>;
  } else if (!url) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress aria-label="Loading document" />
      </Box>
    );
  } else if (kind === 'pdf') {
    body = (
      <Box
        component="iframe"
        src={url}
        title={`Preview of ${name}`}
        sx={{ display: 'block', width: '100%', height: fullScreen ? '75vh' : '70vh', border: 0 }}
      />
    );
  } else if (kind === 'image' && !imageFailed) {
    body = (
      <Box
        component="img"
        src={url}
        alt={name}
        onError={() => setImageFailed(true)}
        sx={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', mx: 'auto' }}
      />
    );
  } else {
    body = (
      <Alert severity="info">This file can&apos;t be shown here. Open it in a new tab.</Alert>
    );
  }

  return (
    <Dialog
      open={doc !== null}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      fullScreen={fullScreen}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        {name}
      </DialogTitle>
      <DialogContent dividers>
        {body}
        {url && kind === 'pdf' && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            If the preview stays blank, open the file in a new tab.
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {url && (
          <Link href={url} target="_blank" rel="noopener noreferrer" sx={{ mr: 'auto', ml: 1 }}>
            Open in a new tab
          </Link>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
