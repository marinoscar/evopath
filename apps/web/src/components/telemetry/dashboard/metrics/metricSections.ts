/**
 * The Telemetry Dashboard's infrastructure sections — issue #127, epic #576.
 *
 * One section per `/metrics` group (#126), in the order the page shows them,
 * with the anchor a verdict reason links to. Which reason belongs to which
 * section is read off the wording of the API's infrastructure verdict rules
 * (`telemetry-dashboard.verdict.ts`, docs/specs/telemetry.md §11.7); a reason
 * no pattern matches (the traffic rules, "no data") simply gets no link.
 */
import type { DashboardMetricGroup } from '../../../../services/telemetryDashboard';

export interface MetricSectionMeta {
  group: DashboardMetricGroup;
  title: string;
}

export const METRIC_SECTIONS: readonly MetricSectionMeta[] = [
  { group: 'host', title: 'Infrastructure' },
  { group: 'database', title: 'Database' },
  { group: 'queue', title: 'Job queue' },
  { group: 'nodes', title: 'Worker nodes' },
  { group: 'uptime', title: 'Uptime & dependencies' },
  { group: 'pipeline', title: 'Telemetry pipeline' },
];

export function metricSectionTitle(group: DashboardMetricGroup): string {
  return METRIC_SECTIONS.find((section) => section.group === group)?.title ?? group;
}

/** The DOM id of a section's anchor (the verdict banner scrolls to it). */
export function metricSectionAnchor(group: DashboardMetricGroup): string {
  return `telemetry-section-${group}`;
}

/** The section's `DashboardPanel` id (tests, and the ⋮ menu focus return). */
export function metricPanelId(group: DashboardMetricGroup): string {
  return `panel-metrics-${group}`;
}

const REASON_PATTERNS: readonly [RegExp, DashboardMetricGroup][] = [
  [/^Disk \S+% full/, 'host'],
  [/^Memory \S+% used/, 'host'],
  [/^Database connections at/, 'database'],
  [/^Oldest pending job waiting/, 'queue'],
  [/^Last successful backup/, 'queue'],
  [/job type\(s\) have pending work and no eligible worker node/, 'nodes'],
  [/worker node\(s\) stale/, 'nodes'],
  [/^TLS certificate (expires|expired)/, 'uptime'],
  [/^Uptime check (failed|failing)/, 'uptime'],
  [/^Collector failed to export/, 'pipeline'],
];

/** The section a verdict reason is about, or null for the traffic and no-data rules. */
export function verdictReasonGroup(reason: string): DashboardMetricGroup | null {
  for (const [pattern, group] of REASON_PATTERNS) if (pattern.test(reason)) return group;
  return null;
}

/** Scroll a section into view and move focus to it (its region is focusable for this). */
export function scrollToMetricSection(group: DashboardMetricGroup): void {
  const target = document.getElementById(metricSectionAnchor(group));
  if (!target) return;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
}
