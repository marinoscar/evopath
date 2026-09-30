import { MemorySaver } from '@langchain/langgraph-checkpoint';

import type { AdaptCheckpointer } from '../graph/adapt-graph';

/**
 * An in-memory checkpointer for the quick adaptation graph (E6.1) in tests,
 * so `training-adaptation/` specs and harnesses never import LangGraph
 * themselves (CLAUDE.md AI rule 6).
 */
export function inMemoryAdaptCheckpointer(): AdaptCheckpointer {
  return new MemorySaver();
}
