import { stubNode } from './stub-node';

/** Researches the evidence for the goal. STUB (the researcher replaces it). */
export const researchNode = stubNode('research', async () => ({
  brief: { stub: true, items: 0 },
}));
