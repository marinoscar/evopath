// =============================================================================
// Data minimisation for coach chat tool results (E7.7, #247)
// =============================================================================
//
// `withoutIds` deep-copies a value, dropping every key that names an internal
// id (`id`, `programId`, `exerciseIds`, ...): the never-send list
// (training-agents/context/never-send.ts, `ids`) applies to tool results too.
// =============================================================================

const ID_KEY = /^(?:id|ids|[a-z][a-zA-Z0-9]*(?:Id|Ids))$/;

/** A deep copy of `value` without id keys. Dates become ISO strings. */
export function withoutIds<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutIds(item));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (ID_KEY.test(key)) continue;
      out[key] = withoutIds(item);
    }
    return out;
  }
  return value;
}

/** Runs a read and answers `fallback` instead of throwing. */
export async function safely<T, F>(read: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
