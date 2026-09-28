// =============================================================================
// No redirects for administrator-chosen AI endpoints (issue #448, epic #421)
// =============================================================================
//
// The Azure OpenAI and OpenAI-compatible adapters send this server's requests
// to a host an ADMINISTRATOR typed in. That host being internal is an
// explicit, admin-only decision (the settings schema documents it); what must
// never happen is the host answering `302 Location: http://169.254.169.254/…`
// (or any other origin) and the SDK's `fetch` quietly following it — with the
// request's `api-key`/`Authorization` header and body — somewhere nobody
// configured.
//
// DECISION: REFUSE EVERY REDIRECT, same-origin included. An OpenAI-shaped API
// root has no business redirecting a POST, a same-origin redirect is almost
// always a misconfigured `baseUrl` (a missing `/v1`, a trailing slash) that is
// better reported than silently absorbed, and "same origin" is exactly the
// check an attacker controlling DNS or a reverse proxy would aim to confuse.
// Refusing all of them is the simplest rule that cannot be wrong.
//
// HOW. Every request goes out with `redirect: 'manual'`, so the platform
// `fetch` returns the 3xx itself instead of following it. That 3xx is then
// replaced by a synthetic error response the SDK turns into an ordinary
// `APIError` (status kept, `code: 'redirect_refused'`), which `mapOpenAiError`
// maps to `AI_PROVIDER_UNAVAILABLE` like any other unusable answer — never a
// raw exception, never the `Location` it pointed at.
// =============================================================================

import type { OpenAiFetch } from './openai-client.factory';

/** The OpenAI-shaped error code a refused redirect surfaces as (in `details.providerCode`). */
export const REDIRECT_REFUSED_CODE = 'redirect_refused';

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * `fetch` (the injected one, or the platform's) with redirects refused — see
 * the file header.
 */
export function noRedirectFetch(fetch: OpenAiFetch = globalThis.fetch.bind(globalThis)): OpenAiFetch {
  return async (input, init) => {
    const response = await fetch(input, { ...(init ?? {}), redirect: 'manual' });

    if (!isRedirect(response)) return response;

    // Drop the redirect's own body unread; it is not ours to parse.
    await response.body?.cancel().catch(() => undefined);

    return new Response(
      JSON.stringify({
        error: {
          message: 'The AI endpoint answered with a redirect, and redirects are not followed.',
          type: 'invalid_request_error',
          param: null,
          code: REDIRECT_REFUSED_CODE,
        },
      }),
      {
        // An opaque redirect reports status 0, which a Response cannot carry.
        status: response.status >= 300 && response.status < 400 ? response.status : 310,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}
