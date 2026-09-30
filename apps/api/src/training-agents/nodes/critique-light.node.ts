import { stubNode } from './stub-node';

/**
 * The E5.5 critic in `mode: 'adaptation'`, only when accepted operations
 * include a structural one (`routeAfterEnvelope`). STUB (part B replaces it):
 * passes through.
 */
export const critiqueLightNode = stubNode('critique_light', async () => ({}));
