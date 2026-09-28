/**
 * The images an AI image run created — issue #445 (Image mode, #437 API).
 *
 * A succeeded image run's output names STORAGE OBJECTS the caller owns, never
 * bytes or provider URLs. Each tile asks `GET /storage/objects/:id/download`
 * for a short-lived signed URL and shows the image from it, with a Download
 * link to the same URL. The URL is held in component state only.
 *
 * ACCESSIBILITY. Every image's alt text is the prompt that produced it (plus
 * its position when there are several), so a screen-reader user hears what
 * was asked for — the one description of the picture this page has.
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Paper, Skeleton, Typography } from '@mui/material';
import { Download as DownloadIcon } from '@mui/icons-material';
import type { AiImageRunOutput } from '../../services/ai';
import { getStorageObjectDownloadUrl } from '../../services/storage';
import { ApiError } from '../../services/api';
import { useIsMounted } from '../../hooks/useIsMounted';

export interface AiImageGalleryProps {
  output: AiImageRunOutput;
  /** The prompt the images were made from — their alt text. */
  prompt: string;
}

/** The alt text for image `index` of `count` made from `prompt`. */
export function aiImageAltText(prompt: string, index: number, count: number): string {
  const text = prompt.trim() || 'AI-generated image';
  return count > 1 ? `${text} (image ${index + 1} of ${count})` : text;
}

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype;
}

export interface AiImageTileProps {
  storageObjectId: string;
  mimeType: string;
  alt: string;
  index: number;
  revisedPrompt?: string;
}

export function AiImageTile({ storageObjectId, mimeType, alt, index, revisedPrompt }: AiImageTileProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    setUrl(null);
    setError(null);
    void (async () => {
      try {
        const signed = await getStorageObjectDownloadUrl(storageObjectId);
        if (isMounted()) setUrl(signed.url);
      } catch (err) {
        if (isMounted()) setError(err instanceof ApiError ? err.message : 'Could not load this image');
      }
    })();
  }, [storageObjectId, isMounted]);

  return (
    <Paper variant="outlined" component="figure" sx={{ m: 0, p: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : url ? (
        <Box
          component="img"
          src={url}
          alt={alt}
          loading="lazy"
          sx={{ width: '100%', height: 'auto', display: 'block', borderRadius: 1, bgcolor: 'action.hover' }}
        />
      ) : (
        <Skeleton variant="rectangular" sx={{ width: '100%', aspectRatio: '1 / 1', height: 'auto' }} aria-label="Loading image" />
      )}
      <Box component="figcaption" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {revisedPrompt && (
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
            Revised prompt: {revisedPrompt}
          </Typography>
        )}
        <Box sx={{ flex: revisedPrompt ? 0 : 1 }} />
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          component="a"
          href={url ?? undefined}
          download={`ai-image-${index + 1}.${extensionFor(mimeType)}`}
          target="_blank"
          rel="noopener noreferrer"
          disabled={!url}
          aria-label={`Download image ${index + 1}`}
        >
          Download
        </Button>
      </Box>
    </Paper>
  );
}

export function AiImageGallery({ output, prompt }: AiImageGalleryProps) {
  const count = output.images.length;

  if (count === 0) {
    return <Alert severity="info">The run finished without returning any images.</Alert>;
  }

  return (
    <Box
      role="list"
      aria-label="Generated images"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: count > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr' },
        gap: 2,
      }}
    >
      {output.images.map((image, index) => (
        <Box role="listitem" key={image.storageObjectId} sx={{ minWidth: 0 }}>
          <AiImageTile
            storageObjectId={image.storageObjectId}
            mimeType={image.mimeType}
            alt={aiImageAltText(prompt, index, count)}
            index={index}
            revisedPrompt={image.revisedPrompt}
          />
        </Box>
      ))}
    </Box>
  );
}

export default AiImageGallery;
