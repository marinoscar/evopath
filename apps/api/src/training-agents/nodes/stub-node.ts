import type { GraphNode, NodeFn } from '../graph/node-context';

/**
 * A stub node: it echoes canned state so the runtime kit is testable before
 * the agents exist. The story that implements the node replaces the file's
 * `run` and sets `implemented: true`. Stubs never call a model.
 */
export function stubNode(name: string, run: NodeFn): GraphNode {
  return { name, run, implemented: false };
}
