/**
 * Compare two progress photos (E7.9, #249): side by side, or one over the
 * other with a before/after divider the user drags.
 *
 * The starting mode follows the window: the slider below `sm` (a phone has no
 * room for two tall photos side by side), side by side from `sm` up. Either
 * mode can be picked by hand at any width.
 *
 * ACCESSIBILITY. The divider is an MUI `Slider` (`role="slider"`), so it is
 * keyboard operable (arrows step 1%, Page Up/Down 10%, Home/End the ends) and
 * announces "40% before photo". Dragging on the photo itself moves it too.
 * Each image's alternative text is its date and pose, never a description of
 * the body.
 */
import { useRef, useState, type PointerEvent } from 'react';
import { Box, Slider, ToggleButton, ToggleButtonGroup, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  formatPhotoDate,
  progressPhotoAlt,
  type ProgressPhoto,
} from '../../services/progressPhotos';
import { ProgressPhotoImage } from './ProgressPhotoImage';

export type PhotoCompareMode = 'side' | 'slider';

export const COMPARE_SLIDER_LABEL = 'Before and after divider';

export interface PhotoCompareProps {
  before: ProgressPhoto;
  after: ProgressPhoto;
  /** Overrides the width-based starting mode (tests, a remembered choice). */
  initialMode?: PhotoCompareMode;
}

function CornerLabel({ children, side }: { children: string; side: 'left' | 'right' }) {
  return (
    <Typography
      variant="caption"
      aria-hidden
      sx={{
        position: 'absolute',
        top: 8,
        [side]: 8,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        bgcolor: 'rgba(0, 0, 0, 0.6)',
        color: '#fff',
        pointerEvents: 'none',
      }}
    >
      {children}
    </Typography>
  );
}

function CompareSlider({ before, after }: { before: ProgressPhoto; after: ProgressPhoto }) {
  const [position, setPosition] = useState(50);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.round(Math.min(100, Math.max(0, pct))));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveTo(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) moveTo(event.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return (
    <Box>
      <Box
        ref={frameRef}
        data-testid="compare-slider-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 480,
          mx: 'auto',
          aspectRatio: '3 / 4',
          touchAction: 'none',
          cursor: 'ew-resize',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <ProgressPhotoImage
          storageObjectId={after.storageObjectId}
          alt={`After: ${progressPhotoAlt(after)}`}
          sx={{ position: 'absolute', inset: 0 }}
        />
        <Box
          data-testid="compare-before-layer"
          sx={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          <ProgressPhotoImage
            storageObjectId={before.storageObjectId}
            alt={`Before: ${progressPhotoAlt(before)}`}
            sx={{ position: 'absolute', inset: 0 }}
          />
        </Box>
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${position}%`,
            width: 2,
            ml: '-1px',
            bgcolor: 'common.white',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }}
        />
        <CornerLabel side="left">{`Before · ${formatPhotoDate(before.localDate)}`}</CornerLabel>
        <CornerLabel side="right">{`After · ${formatPhotoDate(after.localDate)}`}</CornerLabel>
      </Box>
      <Box sx={{ maxWidth: 480, mx: 'auto', px: 1 }}>
        <Slider
          value={position}
          min={0}
          max={100}
          step={1}
          shiftStep={10}
          onChange={(_, value) => setPosition(value as number)}
          aria-label={COMPARE_SLIDER_LABEL}
          getAriaValueText={(value) => `${value}% before photo`}
        />
      </Box>
    </Box>
  );
}

function SideBySide({ before, after }: { before: ProgressPhoto; after: ProgressPhoto }) {
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}
      data-testid="compare-side-by-side"
    >
      {(
        [
          ['Before', before],
          ['After', after],
        ] as const
      ).map(([label, photo]) => (
        <Box component="figure" key={label} sx={{ m: 0, minWidth: 0 }}>
          <ProgressPhotoImage
            storageObjectId={photo.storageObjectId}
            alt={`${label}: ${progressPhotoAlt(photo)}`}
            sx={{ width: '100%', aspectRatio: '3 / 4', borderRadius: 1 }}
          />
          <Typography component="figcaption" variant="body2" sx={{ mt: 0.5, textAlign: 'center' }}>
            {label} · {formatPhotoDate(photo.localDate)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function PhotoCompare({ before, after, initialMode }: PhotoCompareProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const [chosen, setChosen] = useState<PhotoCompareMode | null>(initialMode ?? null);
  const mode: PhotoCompareMode = chosen ?? (isPhone ? 'slider' : 'side');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <ToggleButtonGroup
        value={mode}
        exclusive
        size="small"
        aria-label="Compare view"
        onChange={(_, value: PhotoCompareMode | null) => {
          if (value) setChosen(value);
        }}
        sx={{ alignSelf: 'center' }}
      >
        <ToggleButton value="side">Side by side</ToggleButton>
        <ToggleButton value="slider">Slider</ToggleButton>
      </ToggleButtonGroup>
      {mode === 'slider' ? <CompareSlider before={before} after={after} /> : <SideBySide before={before} after={after} />}
    </Box>
  );
}

export default PhotoCompare;
