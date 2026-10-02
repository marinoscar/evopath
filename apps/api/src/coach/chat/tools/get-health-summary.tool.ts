import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { sendableHealthSummary } from '../../../training-agents/context/build-planner-context';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/** Where the user turns on "Use my health data in training plans and coach chat" (web route). */
export const HEALTH_SUMMARY_CONSENT_PATH = '/settings/ai/agents';

export type CoachHealthSummaryResult =
  | {
      available: true;
      narrative: string;
      trainingConsiderations: Array<{ text: string; severity: 'info' | 'caution'; conservative: boolean }>;
      dataAsOf: string | null;
    }
  | { available: false; reason: 'consent_off' | 'none' };

/**
 * `get_health_summary` (#327): the user's opt-in AI health summary, through
 * the SAME door the training agents use (`HealthSummaryReader.forTraining`:
 * consent on AND a `ready` summary) and the SAME urgent-symptom drop
 * (`sendableHealthSummary`). Only the stored text: the narrative, the
 * training considerations and `dataAsOf`. Never a raw lab value, biomarker,
 * blood pressure reading, document or photo.
 *
 * `{ available: false, reason: 'consent_off' }` while the consent is off;
 * `reason: 'none'` when there is no ready summary, or when its text names an
 * urgent symptom (withheld, like a training run).
 */
export function createGetHealthSummaryTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_health_summary',
    description:
      "The user's AI health summary, only if they opted in: a short narrative and training considerations " +
      '(severity info or caution; conservative means go easier) and dataAsOf. No raw lab values. When it answers ' +
      "available false with reason consent_off, the user has not turned on \"Use my health data in training plans " +
      `and coach chat\"; you may tell them it is in Settings > AI > Training agents (${HEALTH_SUMMARY_CONSENT_PATH}).`,
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async (): Promise<CoachHealthSummaryResult | typeof TOOL_UNAVAILABLE> => {
        const reader = deps.healthSummary;
        if (!reader) return TOOL_UNAVAILABLE;
        if (!(await reader.consentOn(ctx.userId))) return { available: false, reason: 'consent_off' };
        const summary = sendableHealthSummary(await reader.forTraining(ctx.userId));
        if (!summary) return { available: false, reason: 'none' };
        return {
          available: true,
          narrative: summary.narrative,
          trainingConsiderations: summary.trainingConsiderations,
          dataAsOf: summary.dataAsOf,
        };
      }, TOOL_UNAVAILABLE),
  });
}
