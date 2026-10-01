import { Injectable } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';

import { APP_METER_NAME } from '../../common/otel/app-metrics.service';
import { telemetryGate } from '../../common/otel/telemetry-gate';
import type { CoachChatSafetyScreen } from './coach-chat-safety';

// =============================================================================
// Coach chat counters (E7.7, #247; docs/specs/ai-coach.md §2.9)
// =============================================================================
//
//   app.coach.chat.turns{coach.outcome}         a turn answered: `model`,
//                                               `safety` (fixed reply, no
//                                               model) or `fallback` (the
//                                               guard replaced the reply)
//   app.coach.chat.safety_hits{coach.screen}    `distress`, `symptom`, `pain`
//   app.coach.chat.tool_calls{coach.tool, coach.status}
//   app.coach.chat.errors{coach.reason}         an AI error code, `cancelled`
//                                               or `internal`
//
// Attribute values are closed sets (tool names, screens, error codes). No
// counter carries a user id, the user's text, the model's text or a tool
// argument. Recorded only while the runtime telemetry gate is open.
// =============================================================================

export type CoachChatTurnOutcome = 'model' | 'safety' | 'fallback';

@Injectable()
export class CoachChatMetrics {
  private readonly turnsCounter: Counter;
  private readonly safetyCounter: Counter;
  private readonly toolCounter: Counter;
  private readonly errorCounter: Counter;

  constructor() {
    const meter = metrics.getMeter(APP_METER_NAME);
    this.turnsCounter = meter.createCounter('app.coach.chat.turns', { description: 'Coach chat turns answered, by outcome' });
    this.safetyCounter = meter.createCounter('app.coach.chat.safety_hits', {
      description: 'Coach chat messages a safety screen matched, by screen',
    });
    this.toolCounter = meter.createCounter('app.coach.chat.tool_calls', {
      description: 'Coach chat tool calls, by tool and status',
    });
    this.errorCounter = meter.createCounter('app.coach.chat.errors', { description: 'Coach chat turns that failed, by reason' });
  }

  turn(outcome: CoachChatTurnOutcome): void {
    if (telemetryGate.isEnabled()) this.turnsCounter.add(1, { 'coach.outcome': outcome });
  }

  safetyHit(screen: CoachChatSafetyScreen): void {
    if (telemetryGate.isEnabled()) this.safetyCounter.add(1, { 'coach.screen': screen });
  }

  toolCall(tool: string, status: string): void {
    if (telemetryGate.isEnabled()) this.toolCounter.add(1, { 'coach.tool': tool, 'coach.status': status });
  }

  error(reason: string): void {
    if (telemetryGate.isEnabled()) this.errorCounter.add(1, { 'coach.reason': reason });
  }
}
