import { stubNode } from './stub-node';

/** Scores the draft; one call is one critic round. STUB (the critic replaces it): always approves. */
export const critiqueNode = stubNode('critique', async (state) => {
  const round = (state.roundCounters.critique ?? 0) + 1;

  return {
    verdicts: [{ stub: true, round, approve: true }],
    roundCounters: { critique: round },
  };
});
