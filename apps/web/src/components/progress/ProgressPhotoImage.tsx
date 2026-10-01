/**
 * One progress photo drawn at full size (E7.9, #249), through the caller's
 * own short-lived signed URL (`GET /storage/objects/:id/download`), from the
 * same in-memory cache `StoragePhotoThumb` uses. The URL is a bearer
 * credential for its lifetime: memory only, never stored or logged.
 *
 * A photo that cannot be loaded shows a "photo unavailable" placeholder with
 * the same accessible name, so nothing else on the page breaks.
 */
import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { HideImageOutlined as RemovedIcon } from '@mui/icons-material';
import { getCachedPhotoUrl, peekCachedPhotoUrl } from '../intake/StoragePhotoThumb';

export interface ProgressPhotoImageProps {
  storageObjectId: string;
  /** Date and pose; never a description of the body. */
  alt: string;
  fit?: 'cover' | 'contain';
  /** Decorative copy (e.g. the ghost overlay): hidden from assistive technology. */
  decorative?: boolean;
  sx?: SxProps<Theme>;
  imgSx?: SxProps<Theme>;
  testId?: string;
}

export function ProgressPhotoImage({
  storageObjectId,
  alt,
  fit = 'cover',
  decorative = false,
  sx,
  imgSx,
  testId,
}: ProgressPhotoImageProps) {
  const [url, setUrl] = useState<string | null>(() => peekCachedPhotoUrl(storageObjectId));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const hit = peekCachedPhotoUrl(storageObjectId);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    getCachedPhotoUrl(storageObjectId)
      .then((signed) => {
        if (!cancelled) setUrl(signed);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storageObjectId]);

  const frame = {
    position: 'relative',
    overflow: 'hidden',
    bgcolor: 'action.hover',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as const;

  if (failed) {
    return (
      <Box
        sx={[frame, ...(Array.isArray(sx) ? sx : [sx])]}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : `${alt}: photo unavailable`}
        aria-hidden={decorative || undefined}
        data-testid={testId}
      >
        <RemovedIcon color="disabled" />
        <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
          Photo unavailable
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={[frame, ...(Array.isArray(sx) ? sx : [sx])]}
      data-testid={testId}
      role={!url && !decorative ? 'img' : undefined}
      aria-label={!url && !decorative ? alt : undefined}
      aria-hidden={decorative || undefined}
    >
      {url && (
        <Box
          component="img"
          src={url}
          alt={decorative ? '' : alt}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          sx={[
            { width: '100%', height: '100%', objectFit: fit, display: 'block', userSelect: 'none' },
            ...(Array.isArray(imgSx) ? imgSx : [imgSx]),
          ]}
        />
      )}
    </Box>
  );
}

export default ProgressPhotoImage;
