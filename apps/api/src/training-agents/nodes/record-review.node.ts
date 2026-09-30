import { stubNode } from './stub-node';

/** Records a `reviewed` entry (assessment, no version bump). STUB (part B replaces it): records the outcome only. */
export const recordReviewNode = stubNode('record_review', async () => ({
  outcome: { status: 'no_change', verdict: 'reviewed' },
}));
