/**
 * Worker node vitals — the pure helpers and the fleet table's compact cell
 * (`pages/Admin/workerVitals.tsx`, issue #131).
 *
 * The rules this file pins: absent is not zero, freshness is the API's health
 * verdict (never a clock here), stale/offline is said in words as well as
 * grey, and the fleet arithmetic counts exactly the nodes it claims to.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  NodeVitalsCell,
  countLowDisk,
  fleetSaturation,
  formatCpu,
  formatEventLoopDelay,
  formatPercent,
  formatSlots,
  formatUptime,
  formatVitalsReported,
  isLowDisk,
  ratio,
  staleLabel,
  vitalsSummaryText,
} from '../../../pages/Admin/workerVitals';
import {
  fullVitals,
  lowDiskVitals,
  partialVitals,
  versionsOnlyVitals,
  vitalsNode,
} from '../../mocks/fixtures/nodeVitals';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const THREE_MIN_AGO = '2026-01-01T11:57:00.000Z';

// =============================================================================
// Formatters
// =============================================================================

describe('formatters', () => {
  it('ratio is null when either side is missing or the total is not positive', () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(undefined, 4)).toBeNull();
    expect(ratio(1, undefined)).toBeNull();
    expect(ratio(1, 0)).toBeNull();
  });

  it('prints an absent reading as an em dash, never as zero', () => {
    expect(formatCpu(undefined)).toBe('—');
    expect(formatEventLoopDelay(undefined)).toBe('—');
    expect(formatUptime(undefined)).toBe('—');
    expect(formatPercent(null)).toBe('—');
  });

  it('does not cap CPU at 100% — 100 is one core', () => {
    expect(formatCpu(250)).toBe('250%');
    expect(formatCpu(3.25)).toBe('3.3%');
    expect(formatCpu(0)).toBe('0.0%');
  });

  it('formats event-loop delay and uptime in the admin vocabulary', () => {
    expect(formatEventLoopDelay(12.6)).toBe('13 ms');
    expect(formatEventLoopDelay(1.24)).toBe('1.2 ms');
    expect(formatUptime(2 * 86_400 + 3 * 3_600)).toBe('2d 3h');
  });

  it('formats slots only when both halves are reported', () => {
    expect(formatSlots(fullVitals)).toBe('1/4');
    expect(formatSlots({ slotsUsed: 1 })).toBeNull();
  });

  it('says when vitals were reported, relative to the page clock', () => {
    expect(formatVitalsReported(THREE_MIN_AGO, NOW)).toBe('Vitals reported 3 minutes ago');
    expect(formatVitalsReported(null, NOW)).toBeNull();
  });

  it('labels greyed vitals with the node’s own health word', () => {
    expect(staleLabel(vitalsNode({ health: 'stale' }))).toBe('Stale');
    expect(staleLabel(vitalsNode({ health: 'offline' }))).toBe('Offline');
  });
});

// =============================================================================
// Low disk
// =============================================================================

describe('low disk', () => {
  it('is under 10% free, and not at exactly 10%', () => {
    expect(isLowDisk(lowDiskVitals)).toBe(true);
    expect(isLowDisk(fullVitals)).toBe(false);
    expect(isLowDisk({ stateDirFreeBytes: 10, stateDirTotalBytes: 100 })).toBe(false);
    expect(isLowDisk({ stateDirFreeBytes: 9, stateDirTotalBytes: 100 })).toBe(true);
  });

  it('is never inferred from a missing disk reading', () => {
    expect(isLowDisk(null)).toBe(false);
    expect(isLowDisk(partialVitals)).toBe(false);
    expect(isLowDisk({ stateDirFreeBytes: 0 })).toBe(false);
  });

  it('counts healthy and stale nodes, but not offline ones or ones without vitals', () => {
    const nodes = [
      vitalsNode({ id: 'a', lastVitals: lowDiskVitals }),
      vitalsNode({ id: 'b', health: 'stale', lastVitals: lowDiskVitals }),
      vitalsNode({ id: 'c', health: 'offline', lastVitals: lowDiskVitals }),
      vitalsNode({ id: 'd', lastVitals: fullVitals }),
      vitalsNode({ id: 'e', lastVitals: null }),
    ];
    expect(countLowDisk(nodes)).toBe(2);
    expect(countLowDisk([])).toBe(0);
  });
});

// =============================================================================
// Fleet saturation
// =============================================================================

describe('fleetSaturation', () => {
  it('is Σ slotsUsed / Σ slotsTotal over healthy nodes that reported both', () => {
    const result = fleetSaturation([
      vitalsNode({ id: 'a', lastVitals: { slotsUsed: 3, slotsTotal: 4 } }),
      vitalsNode({ id: 'b', lastVitals: { slotsUsed: 1, slotsTotal: 4 } }),
      // Excluded: stale, offline, no vitals, only one half reported.
      vitalsNode({ id: 'c', health: 'stale', lastVitals: { slotsUsed: 8, slotsTotal: 8 } }),
      vitalsNode({ id: 'd', health: 'offline', lastVitals: { slotsUsed: 8, slotsTotal: 8 } }),
      vitalsNode({ id: 'e', lastVitals: null }),
      vitalsNode({ id: 'f', lastVitals: { slotsTotal: 16 } }),
    ]);
    expect(result).toEqual({ used: 4, total: 8, reporting: 2, fraction: 0.5 });
  });

  it('is unknown — not 0% — when no healthy node reported slots', () => {
    expect(fleetSaturation([vitalsNode({ health: 'stale', lastVitals: fullVitals })])).toEqual({
      used: 0,
      total: 0,
      reporting: 0,
      fraction: null,
    });
    expect(fleetSaturation([]).fraction).toBeNull();
  });

  it('counts an idle healthy fleet as 0%, which is a real reading', () => {
    expect(fleetSaturation([vitalsNode({ lastVitals: partialVitals })]).fraction).toBe(0);
  });
});

// =============================================================================
// Summary text (the column's scalar / CSV)
// =============================================================================

describe('vitalsSummaryText', () => {
  it('summarises a full snapshot', () => {
    expect(vitalsSummaryText(vitalsNode({ lastVitals: fullVitals }))).toBe(
      'CPU 42% · RSS 512 MB · Heap 25% · Disk 50% free · Slots 1/4',
    );
  });

  it('leaves unreported fields out of the sentence', () => {
    expect(vitalsSummaryText(vitalsNode({ lastVitals: partialVitals }))).toBe(
      'CPU 3.3% · Slots 0/2',
    );
  });

  it('says "No vitals" for none, or for nothing summarisable', () => {
    expect(vitalsSummaryText(vitalsNode())).toBe('No vitals');
    expect(vitalsSummaryText(vitalsNode({ lastVitals: versionsOnlyVitals }))).toBe('No vitals');
  });

  it('prefixes the health word when the node is not healthy', () => {
    expect(vitalsSummaryText(vitalsNode({ health: 'offline', lastVitals: partialVitals }))).toBe(
      'Offline: CPU 3.3% · Slots 0/2',
    );
  });
});

// =============================================================================
// The compact cell
// =============================================================================

describe('NodeVitalsCell', () => {
  function renderCell(overrides: Parameters<typeof vitalsNode>[0]) {
    const node = vitalsNode(overrides);
    render(<NodeVitalsCell node={node} now={NOW} />);
    return screen.getByTestId(`node-vitals-${node.id}`);
  }

  it('renders CPU, slots, memory (RSS + heap) and disk free/total', () => {
    const cell = renderCell({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    expect(cell).toHaveTextContent('CPU 42% · Slots 1/4');
    expect(cell).toHaveTextContent('Mem 512 MB (heap 25%)');
    expect(cell).toHaveTextContent('Disk 50% free');
    expect(cell).toHaveAttribute('data-stale', 'false');
    expect(cell).not.toHaveTextContent('Stale');
  });

  it('renders a muted "No vitals" when the node never sent any', () => {
    const cell = renderCell({ lastVitals: null });
    expect(cell).toHaveTextContent(/^No vitals$/);
  });

  it('renders "No vitals" when the snapshot has nothing the cell shows', () => {
    expect(renderCell({ lastVitals: versionsOnlyVitals })).toHaveTextContent(/^No vitals$/);
  });

  it('omits unreported fields rather than printing them as zero or a dash', () => {
    const cell = renderCell({ lastVitals: { slotsUsed: 1, slotsTotal: 2 } });
    expect(cell).toHaveTextContent('Slots 1/2');
    expect(cell).not.toHaveTextContent('CPU');
    expect(cell).not.toHaveTextContent('Mem');
    expect(cell).not.toHaveTextContent('Disk');
  });

  it('greys a STALE node’s vitals AND says "Stale" in words', () => {
    const cell = renderCell({ health: 'stale', lastVitals: fullVitals });
    expect(cell).toHaveAttribute('data-stale', 'true');
    expect(cell).toHaveTextContent('Stale · CPU 42%');
  });

  it('labels an OFFLINE node’s vitals "Offline", not "Stale"', () => {
    const cell = renderCell({ health: 'offline', lastVitals: fullVitals });
    expect(cell).toHaveAttribute('data-stale', 'true');
    expect(cell).toHaveTextContent('Offline · CPU 42%');
    expect(cell).not.toHaveTextContent('Stale');
  });

  it('flags low disk in words, not only in colour', () => {
    expect(renderCell({ lastVitals: lowDiskVitals })).toHaveTextContent('Disk 5% free (low)');
  });
});
