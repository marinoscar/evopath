/**
 * A thumbnail of one of the caller's stored photos, through a signed URL
 * fetched when the thumbnail mounts (`GET /storage/objects/:id/download`).
 *
 * ⚠ A SIGNED URL IS A BEARER CREDENTIAL for its lifetime: it lives in this
 * module's memory only (shared between thumbnails of the same photo until it
 * is close to expiry), never in storage, never logged.
 *
 * A photo that is gone (deleted from storage mid-review, or never listed)
 * renders a "photo removed" placeholder; nothing else breaks.
 *
 * A PDF (H2, #186; told by its `.pdf` name, since the intake view carries no
 * type) is shown as a file icon, and no signed URL is fetched for it: an
 * `<img>` cannot draw a PDF.
 */
import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import {
  HideImageOutlined as RemovedIcon,
  ImageOutlined as ImageIcon,
  PictureAsPdfOutlined as PdfIcon,
} from '@mui/icons-material';
import { getStorageObjectDownloadUrl } from '../../services/storage';

const cache = new Map<string, { url: string; expiresAt: number }>();
/** Re-fetch this long before a cached URL expires. */
const EXPIRY_MARGIN_MS = 30_000;

function cached(id: string): string | null {
  const hit = cache.get(id);
  if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return hit.url;
  cache.delete(id);
  return null;
}

/**
 * A signed URL for one of the caller's photos, from the same in-memory cache
 * the thumbnails use (E7.9 #249: the progress-photo viewer and compare draw
 * the full image, not a square thumb). Fetches only on a miss.
 */
export async function getCachedPhotoUrl(id: string): Promise<string> {
  const hit = cached(id);
  if (hit) return hit;
  const { url, expiresIn } = await getStorageObjectDownloadUrl(id);
  cache.set(id, { url, expiresAt: Date.now() + expiresIn * 1000 });
  return url;
}

/** The cached signed URL for `id` when it is still fresh, else `null` (no fetch). */
export function peekCachedPhotoUrl(id: string): string | null {
  return cached(id);
}

/** For tests: forget every cached URL. */
export function clearPhotoUrlCache(): void {
  cache.clear();
}

export interface StoragePhotoThumbProps {
  /** `null` when the photo is known to be missing. */
  storageObjectId: string | null;
  name: string;
  size?: number;
}

const isPdfName = (name: string) => /\.pdf$/i.test(name);

export function StoragePhotoThumb({ storageObjectId, name, size = 56 }: StoragePhotoThumbProps) {
  const pdf = isPdfName(name);
  const [url, setUrl] = useState<string | null>(() => (storageObjectId && !pdf ? cached(storageObjectId) : null));
  const [missing, setMissing] = useState(storageObjectId === null);

  useEffect(() => {
    if (pdf && storageObjectId) {
      setMissing(false);
      return;
    }
    if (!storageObjectId) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const hit = cached(storageObjectId);
    if (hit) {
      setUrl(hit);
      return;
    }
    let cancelled = false;
    getStorageObjectDownloadUrl(storageObjectId)
      .then(({ url: signed, expiresIn }) => {
        cache.set(storageObjectId, { url: signed, expiresAt: Date.now() + expiresIn * 1000 });
        if (!cancelled) setUrl(signed);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storageObjectId, pdf]);

  const frame = {
    width: size,
    height: size,
    borderRadius: 1,
    overflow: 'hidden',
    flexShrink: 0,
    bgcolor: 'action.hover',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as const;

  if (missing) {
    return (
      <Box sx={{ ...frame, flexDirection: 'column', px: 0.5 }} role="img" aria-label={`${name}: photo removed`}>
        <RemovedIcon fontSize="small" color="disabled" />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.1, textAlign: 'center' }}>
          photo removed
        </Typography>
      </Box>
    );
  }

  if (pdf) {
    return (
      <Box sx={{ ...frame, flexDirection: 'column' }} role="img" aria-label={`${name} (PDF)`} data-testid="storage-pdf-thumb">
        <PdfIcon fontSize={size >= 96 ? 'large' : 'small'} color="action" />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.1 }}>
          PDF
        </Typography>
      </Box>
    );
  }

  if (!url) {
    return (
      <Box sx={frame} role="img" aria-label={name}>
        <ImageIcon fontSize="small" color="disabled" />
      </Box>
    );
  }

  return (
    <Box sx={frame}>
      <Box
        component="img"
        src={url}
        alt={name}
        loading="lazy"
        onError={() => setMissing(true)}
        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </Box>
  );
}

export default StoragePhotoThumb;
