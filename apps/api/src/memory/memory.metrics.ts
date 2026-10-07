import { Injectable } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';

import { APP_METER_NAME } from '../common/otel/app-metrics.service';
import { telemetryGate } from '@marinoscar/platform-api/otel-core';

// =============================================================================
// User memory counters (#325; docs/specs/ai-memory.md §2.8)
// =============================================================================
//
//   app.memory.added{memory.source}
//   app.memory.updated{memory.source}
//   app.memory.deleted{memory.source}
//   app.memory.noop{memory.source}
//   app.memory.rejected{memory.source, memory.rule}
//
// `memory.source` is `explicit`, `extracted` or `user_edited`; `memory.rule`
// is a validation rule (`instruction`, `url`, ...), `health_not_allowed`,
// `immutable` or `limit`. Closed sets only: no counter carries a user id or
// any memory text. Recorded only while the runtime telemetry gate is open.
// =============================================================================

const SOURCES = new Set(['explicit', 'extracted', 'user_edited']);

function source(value: string): string {
  return SOURCES.has(value) ? value : 'other';
}

@Injectable()
export class MemoryMetrics {
  private readonly addedCounter: Counter;
  private readonly updatedCounter: Counter;
  private readonly deletedCounter: Counter;
  private readonly noopCounter: Counter;
  private readonly rejectedCounter: Counter;

  constructor() {
    const meter = metrics.getMeter(APP_METER_NAME);
    this.addedCounter = meter.createCounter('app.memory.added', { description: 'User memories added, by source' });
    this.updatedCounter = meter.createCounter('app.memory.updated', { description: 'User memories updated or superseded, by source' });
    this.deletedCounter = meter.createCounter('app.memory.deleted', { description: 'User memories deleted, by source' });
    this.noopCounter = meter.createCounter('app.memory.noop', { description: 'Memory writes that changed nothing, by source' });
    this.rejectedCounter = meter.createCounter('app.memory.rejected', { description: 'Memory writes refused, by source and rule' });
  }

  added(src: string): void {
    if (telemetryGate.isEnabled()) this.addedCounter.add(1, { 'memory.source': source(src) });
  }

  updated(src: string): void {
    if (telemetryGate.isEnabled()) this.updatedCounter.add(1, { 'memory.source': source(src) });
  }

  deleted(src: string): void {
    if (telemetryGate.isEnabled()) this.deletedCounter.add(1, { 'memory.source': source(src) });
  }

  noop(src: string): void {
    if (telemetryGate.isEnabled()) this.noopCounter.add(1, { 'memory.source': source(src) });
  }

  rejected(src: string, rule: string): void {
    if (telemetryGate.isEnabled()) this.rejectedCounter.add(1, { 'memory.source': source(src), 'memory.rule': rule });
  }
}
