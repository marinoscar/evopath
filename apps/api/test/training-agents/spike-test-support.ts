// Shared fixtures for the training-agents specs that drive the spike graph
// through the real `AiService` (fake provider). Not a `*.spec.ts` file, so
// Jest never runs it as a suite.

import { randomUUID } from 'node:crypto';

import type { Job } from '@prisma/client';

import type { AiResponseRequest } from '../../src/ai/core/types/responses.types';
import { type AiRuntimeHarnessOptions, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { SPIKE_GRAPH_JOB_TYPE } from '../../src/training-agents/spike/spike-graph.handler';

/** Per-call usage every scripted spike response reports. */
export const SPIKE_CALL_USAGE = { inputTokens: 10, outputTokens: 5 } as const;

export const SPIKE_BRIEF = { summary: 'Brief', sources: ['https://example.com'] };
export const SPIKE_DRAFT = { title: 'Week 1', sessions: [{ day: 1, focus: 'legs' }] };

/** The model row and policy the spike's research node needs (hosted web search). */
export function spikeCatalog(): Pick<AiRuntimeHarnessOptions, 'models' | 'policy'> {
  return {
    models: [
      {
        modelId: HARNESS_MODEL,
        capabilities: {
          ...FAKE_TEXT_MODEL_CAPABILITIES,
          capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
        },
      },
    ],
    policy: { hostedTools: { web_search: true } },
  };
}

/**
 * Harness options whose fake routes on `metadata.agent`: the critic rejects
 * the first `rejections` drafts and approves the next. `onCall` sees each
 * routed request (for scripting delays, throws or counting).
 */
export function spikeHarnessOptions(
  opts: {
    rejections?: number;
    onCall?: (req: AiResponseRequest, ctx: { signal?: AbortSignal }) => void | Promise<void>;
  } = {},
): AiRuntimeHarnessOptions {
  const rejections = opts.rejections ?? 1;
  let critiques = 0;

  return {
    ...spikeCatalog(),
    fake: {
      hostedTools: ['web_search'],
      responses: async (req: AiResponseRequest, ctx) => {
        await opts.onCall?.(req, ctx);

        switch (req.metadata?.agent) {
          case 'researcher':
            return { outputText: JSON.stringify(SPIKE_BRIEF), usage: SPIKE_CALL_USAGE };
          case 'planner':
            return { outputText: JSON.stringify(SPIKE_DRAFT), usage: SPIKE_CALL_USAGE };
          case 'critic': {
            critiques += 1;
            const approve = critiques > rejections;
            return {
              outputText: JSON.stringify({ approve, score: approve ? 8 : 4, notes: approve ? 'ok' : 'revise' }),
              usage: SPIKE_CALL_USAGE,
            };
          }
          default:
            throw new Error(`unexpected agent ${String(req.metadata?.agent)}`);
        }
      },
    },
  };
}

/** A minimal spike job row for calling `SpikeGraphHandler.execute` directly. */
export function spikeJob(payload: Record<string, unknown>): Job {
  return { id: randomUUID(), type: SPIKE_GRAPH_JOB_TYPE, payload } as unknown as Job;
}
