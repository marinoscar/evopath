/**
 * Zoom by selection over a band-scaled time chart — issue #578, epic #576.
 *
 * `@mui/x-charts`' community brush reports coordinates, not a data range, so
 * this is a small overlay of our own: a transparent rect over the drawing area
 * that maps pointer x to the nearest bucket through the chart's own x scale.
 *
 * - `drag`: press, drag across buckets, release → `onSelect(first, last)`.
 * - `tap`:  press and release in place → `onSelect(i, i)` (one bucket).
 *
 * Rendered as a CHILD of the chart surface (it reads the chart context).
 * `touch-action: pan-y` keeps vertical page scrolling working on touch
 * screens while a horizontal drag selects. Keyboard users zoom with the range
 * selector instead; this is a pointer shortcut, not the only way in.
 */
import { useRef, useState, type PointerEvent } from 'react';
import { useTheme } from '@mui/material';
import { useDrawingArea, useXScale } from '@mui/x-charts/hooks';

/** Pixels a pointer must travel before a press counts as a drag, not a tap. */
const DRAG_THRESHOLD_PX = 6;

export interface ZoomBrushProps {
  /** The band values, in order (bucket start timestamps). */
  values: string[];
  drag: boolean;
  tap: boolean;
  onSelect: (startIndex: number, endIndex: number) => void;
}

interface BandScale {
  (value: string): number | undefined;
  bandwidth(): number;
  domain(): string[];
}

export function ZoomBrush({ values, drag, tap, onSelect }: ZoomBrushProps) {
  const theme = useTheme();
  const area = useDrawingArea();
  const scale = useXScale<'band'>() as unknown as BandScale;
  const press = useRef<{ index: number; x: number; pointerId: number } | null>(null);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);

  if (!drag && !tap) return null;
  if (values.length === 0 || area.width <= 0 || typeof scale?.bandwidth !== 'function') return null;

  const bandwidth = scale.bandwidth();
  const indexAt = (clientX: number, target: SVGElement): number => {
    const svg = target.ownerSVGElement ?? target;
    const x = clientX - svg.getBoundingClientRect().left;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    values.forEach((value, index) => {
      const start = scale(value);
      if (start === undefined) return;
      const distance = Math.abs(start + bandwidth / 2 - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    const index = indexAt(event.clientX, event.currentTarget);
    press.current = { index, x: event.clientX, pointerId: event.pointerId };
    if (drag) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setSelection({ a: index, b: index });
    }
  };

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    if (!drag || !press.current || press.current.pointerId !== event.pointerId) return;
    const index = indexAt(event.clientX, event.currentTarget);
    setSelection((current) => (current && current.b !== index ? { a: current.a, b: index } : current));
  };

  const finish = (event: PointerEvent<SVGRectElement>) => {
    const started = press.current;
    press.current = null;
    setSelection(null);
    if (!started || started.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const moved = Math.abs(event.clientX - started.x) >= DRAG_THRESHOLD_PX;
    const index = indexAt(event.clientX, event.currentTarget);
    if (drag && moved && index !== started.index) {
      onSelect(Math.min(started.index, index), Math.max(started.index, index));
    } else if (tap && !moved) {
      onSelect(started.index, started.index);
    }
  };

  const cancel = () => {
    press.current = null;
    setSelection(null);
  };

  let highlight = null;
  if (selection && selection.a !== selection.b) {
    const first = Math.min(selection.a, selection.b);
    const last = Math.max(selection.a, selection.b);
    const x1 = scale(values[first]) ?? area.left;
    const x2 = (scale(values[last]) ?? area.left) + bandwidth;
    highlight = (
      <rect
        data-testid="zoom-selection"
        x={x1}
        y={area.top}
        width={Math.max(0, x2 - x1)}
        height={area.height}
        fill={theme.palette.primary.main}
        fillOpacity={0.15}
        stroke={theme.palette.primary.main}
        strokeOpacity={0.5}
        pointerEvents="none"
      />
    );
  }

  return (
    <g>
      {highlight}
      <rect
        data-testid="zoom-brush"
        x={area.left}
        y={area.top}
        width={area.width}
        height={area.height}
        fill="transparent"
        style={{ touchAction: 'pan-y', cursor: drag ? 'crosshair' : 'pointer' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={cancel}
      />
    </g>
  );
}
