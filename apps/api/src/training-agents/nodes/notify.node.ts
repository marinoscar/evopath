import { stubNode } from './stub-node';

/** Raises `training.plan_adapted` or `training.plan_proposal` after the write committed. STUB (part B replaces it). */
export const notifyNode = stubNode('notify', async () => ({}));
