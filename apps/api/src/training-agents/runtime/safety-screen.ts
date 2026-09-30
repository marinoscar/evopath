import { Injectable } from '@nestjs/common';

import type { RunKind } from '../graph/run-state';

// =============================================================================
// The pre-run safety screen seam
// =============================================================================
//
// `TrainingRunsService.create` asks the screen BEFORE it creates a job or
// calls any provider. A stop answer records the run as `blocked_safety` with
// no job and no provider call, and the route returns the guidance. This story
// ships the seam and a pass-through default; the urgent-symptom screen (the
// planner and guardrails story's `screenFreeText`) replaces the provider
// bound to `TRAINING_SAFETY_SCREEN`.
// =============================================================================

export const TRAINING_SAFETY_SCREEN = Symbol('TRAINING_SAFETY_SCREEN');

export type SafetyScreenResult =
  | { stop: false }
  | {
      stop: true;
      /** What to tell the user (static guidance, never an echo of their words). */
      guidance: string;
      /** A machine code for the record (`TRAINING_SAFETY_STOP` by default). */
      code?: string;
    };

export interface SafetyScreen {
  screen(args: { userId: string; kind: RunKind; input: Record<string, unknown> }): Promise<SafetyScreenResult>;
}

/** The default: lets every request through. */
@Injectable()
export class PassThroughSafetyScreen implements SafetyScreen {
  async screen(): Promise<SafetyScreenResult> {
    return { stop: false };
  }
}
