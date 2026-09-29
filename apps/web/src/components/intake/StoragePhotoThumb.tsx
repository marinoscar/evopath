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
 */
import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { HideImageOutlined as RemovedIcon, ImageOutlined as ImageIcon } from '@mui/icons-material';
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

export function StoragePhotoThumb({ storageObjectId, name, size = 56 }: StoragePhotoThumbProps) {
  const [url, setUrl] = useState<string | null>(() => (storageObjectId ? cached(storageObjectId) : null));
  const [missing, setMissing] = useState(storageObjectId === null);

  useEffect(() => {
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
  }, [storageObjectId]);

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
