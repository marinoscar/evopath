import { stubNode } from './stub-node';

/** Builds the minimised per-role context. STUB (the context builder replaces it). */
export const prepareContextNode = stubNode('prepare_context', async (state) => ({
  context: { stub: true, kind: state.kind },
}));
