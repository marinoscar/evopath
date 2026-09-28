/**
 * The time (x) axis the two dashboard timelines share (#578): a band axis of
 * bucket starts, labelled by time of day (plus the date past 24 h), with at
 * most `maxTicks` labels on phones.
 */
import type { XAxis } from '@mui/x-charts/models';
import { formatBucketLabel, formatTimestamp } from './format';

export const TIMELINE_AXIS_ID = 'time';

export function timelineXAxis(starts: string[], spanMs: number, maxTicks?: number): XAxis<'band'> {
  const step = maxTicks ? Math.max(1, Math.ceil(starts.length / maxTicks)) : 1;
  return {
    id: TIMELINE_AXIS_ID,
    scaleType: 'band',
    data: starts,
    valueFormatter: (value: string, context) =>
      context.location === 'tick' ? formatBucketLabel(value, spanMs) : formatTimestamp(value),
    ...(maxTicks
      ? { tickInterval: (_value: string, index: number) => index % step === 0 }
      : { tickLabelInterval: 'auto' as const }),
    height: 28,
  };
}

/** Timeline height per layout: desktop 320, tablet 280, phone 200. */
export function timelineHeight(layout: 'phone' | 'tablet' | 'desktop'): number {
  return layout === 'desktop' ? 320 : layout === 'tablet' ? 280 : 200;
}
