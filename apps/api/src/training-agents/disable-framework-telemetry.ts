/**
 * Forces every LangChain / LangSmith telemetry switch off, in code.
 *
 * `@langchain/core` depends on `langsmith`, whose tracer posts runs to a
 * LangChain-hosted endpoint whenever one of the tracing variables below reads
 * `"true"`. This deployment never traces to LangSmith: spans are the repo's own
 * OpenTelemetry spans, which carry no prompt text. So this is not
 * configuration and none of these names is documented in `.env.example`: the
 * values are overwritten unconditionally, whatever the environment says.
 *
 * The libraries read `process.env` on every call (no caching in the installed
 * versions), so calling this before a graph is built is enough. It runs once
 * when this file is first imported and again whenever a graph is built
 * (`buildSpikeGraph`, `LangGraphRunner`), so a variable set later in the
 * process's life cannot turn tracing back on.
 */

/** Tracing switches read by `@langchain/core` (`isTracingEnabled`) and `langsmith`. */
export const FORCED_OFF_FLAGS = [
  'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_OTEL_ENABLED',
  'LANGSMITH_TEST_TRACKING',
] as const;

/**
 * Credentials and endpoints the LangSmith client would use. Removed from the
 * process environment so no client can be constructed against them, even by a
 * code path that ignores the tracing flags.
 */
export const REMOVED_VARIABLES = [
  'LANGSMITH_API_KEY',
  'LANGCHAIN_API_KEY',
  'LANGSMITH_ENDPOINT',
  'LANGCHAIN_ENDPOINT',
  'LANGSMITH_RUNS_ENDPOINTS',
] as const;

export function disableFrameworkTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  for (const flag of FORCED_OFF_FLAGS) env[flag] = 'false';
  for (const name of REMOVED_VARIABLES) delete env[name];

  // `"false"` makes `@langchain/core` await callback handlers inline instead
  // of queueing them on a background promise that could outlive a job.
  env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
}

disableFrameworkTelemetry();
