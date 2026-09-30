import { stubNode } from './stub-node';

/** Applies the change set to the plan through `applyChange`. STUB (part B replaces it): records the outcome only. */
export const applyNode = stubNode('apply', async () => ({
  outcome: { status: 'completed', verdict: 'applied' },
}));
