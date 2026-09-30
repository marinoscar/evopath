import { stubNode } from './stub-node';

/** Checks and repairs the draft server-side. STUB (the guardrails replace it). */
export const guardrailsNode = stubNode('guardrails', async () => ({
  guardrailReport: { stub: true, violations: 0 },
}));
