// =============================================================================
// Prompt markers and structured-output names: a CONTRACT
// =============================================================================
//
// E6.4's fake provider server finds the context by these literal markers and
// answers by these schema names, and a contract test pins them. Changing one
// is a breaking change for that server and for recorded fixtures.
// =============================================================================

/** Opens the minimised context JSON inside a prompt's input. */
export const CONTEXT_JSON_OPEN = '<context-json>';

/** Closes the minimised context JSON. */
export const CONTEXT_JSON_CLOSE = '</context-json>';

/** Opens the critic's notes on the revise pass (server-authored codes and the critic's short notes, as data). */
export const CRITIC_NOTES_OPEN = '<critic-notes>';

/** Closes the critic's notes. */
export const CRITIC_NOTES_CLOSE = '</critic-notes>';

/** The planner's structured-output schema name. */
export const ADAPTATION_PROPOSAL_SCHEMA_NAME = 'training_adaptation_proposal';

/** The critic's structured-output schema name. */
export const ADAPTATION_CRITIQUE_SCHEMA_NAME = 'training_adaptation_critique';

/**
 * JSON for a delimited block: `<` is written as `<`, so no value (the
 * user's free text, an equipment name) can close the block early and continue
 * as instructions. `JSON.parse` reads it back unchanged.
 */
export function blockJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The context block: `<context-json>` + JSON + `</context-json>`. */
export function contextBlock(value: unknown): string {
  return `${CONTEXT_JSON_OPEN}\n${blockJson(value)}\n${CONTEXT_JSON_CLOSE}`;
}

/** Reads the JSON between the context markers of an input (what E6.4's fake server does). */
export function parseContextBlock(input: string): unknown {
  const start = input.indexOf(CONTEXT_JSON_OPEN);
  const end = input.indexOf(CONTEXT_JSON_CLOSE, start + CONTEXT_JSON_OPEN.length);
  if (start < 0 || end < 0) return null;
  return JSON.parse(input.slice(start + CONTEXT_JSON_OPEN.length, end));
}
