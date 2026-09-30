import { stubNode } from './stub-node';

/** Assesses progress and proposes typed changes. STUB (the evaluator replaces it). */
export const evaluateNode = stubNode('evaluate', async () => ({
  evaluation: { stub: true },
  changeSet: { stub: true, operations: 0 },
}));
