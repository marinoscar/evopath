import { stubNode } from './stub-node';

/** Loads the training signals an evaluation reads. STUB (the evaluator story replaces it). */
export const loadSignalsNode = stubNode('load_signals', async () => ({
  context: { stub: true, signals: 0 },
}));
