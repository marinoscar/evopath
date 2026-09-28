/**
 * MIME-type matching shared by the upload limits (`ObjectsService`, #519) and
 * the AI storage-input resolver (`ai/storage/ai-storage-input.resolver.ts`).
 *
 * One implementation so an allowlist entry means the same thing wherever it is
 * written: an exact type (`application/pdf`) or a `type/*` wildcard
 * (`image/*`, matching every `image/<subtype>` but not a bare `image/`).
 * Comparison is case-insensitive and ignores parameters (`; charset=...`).
 */

/** Lower-cases `mimeType` and drops any parameters (`text/plain; charset=utf-8` → `text/plain`). */
export function normaliseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether `mimeType` matches an entry of `allowed`.
 *
 * `mimeType` is expected to be normalised already (see `normaliseMimeType`);
 * every entry of `allowed` is normalised here. An empty `allowed` matches
 * nothing: callers that treat an empty list as "allow all" say so themselves.
 */
export function mimeTypeMatches(mimeType: string, allowed: readonly string[]): boolean {
  return allowed.map(normaliseMimeType).some((entry) =>
    entry.endsWith('/*')
      ? mimeType.startsWith(entry.slice(0, -1)) && mimeType.length > entry.length - 1
      : entry === mimeType,
  );
}
