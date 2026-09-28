// =============================================================================
// Provider-hosted tools — validation, policy and secret handling (issue #442)
// =============================================================================
//
// The typed `AiHostedTool` union lives in `types/responses.types.ts`; this file
// is everything that is DONE with one, provider-neutrally:
//
//   - `aiHostedToolSchema` — the one runtime shape check, shared by the HTTP
//     DTO (`POST /api/ai/responses`), the facade (in-process callers are
//     typed, not validated) and the stored background-run request
//     (`aiStoredHostedToolSchema`, which has NO `headers` field at all);
//   - `assertHostedToolsAllowed` — the admin policy gate: a tool type an
//     administrator has not switched on is `AI_TOOL_DISABLED` (403), and so is
//     an MCP server outside `ai.hostedTools.mcpAllowedHosts` when that list is
//     non-empty;
//   - `mcpHeaderValues` / `redactSecretValues` — MCP `headers` are secret
//     material (typically `Authorization: Bearer …` for the remote server).
//     The facade collects their values before the call and scrubs every
//     string of the response with them, so a server that echoes its own
//     credential back cannot put it on the wire either.
//
// Everything here is DEFAULT-CLOSED: every tool type is off until an
// administrator turns it on (egress and cost risk — a web search or an MCP
// call reaches the internet on the deployment's or the user's bill).
// =============================================================================

import { z } from 'zod';

import { AiError } from './ai-error';
import type { AiHostedTool, AiHostedToolType, AiMcpTool, AiTool } from './types/responses.types';

/** The admin policy the gate reads — structurally `ai.hostedTools` from the settings namespace. */
export type AiHostedToolsPolicy = Record<AiHostedToolType, boolean> & {
  /** Hosts an MCP `serverUrl` may name; `*.example.com` matches subdomains. Empty = any `https` host. */
  mcpAllowedHosts: string[];
};

/** Most header entries one MCP tool may carry. */
export const AI_MCP_MAX_HEADERS = 16;

/** A label the provider accepts for an MCP server. */
export const AI_MCP_SERVER_LABEL = /^[a-zA-Z0-9_-]{1,64}$/;

/** An HTTP header field name (RFC 9110 `token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** `https://` only, and never with credentials in the URL — it is stored with a background run. */
const mcpServerUrl = z
  .url({ protocol: /^https$/, error: 'serverUrl must be an https:// URL' })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'serverUrl must not carry credentials; send them in headers');

const webSearchToolSchema = z
  .object({
    type: z.literal('web_search'),
    searchContextSize: z.enum(['low', 'medium', 'high']).optional(),
    userLocation: z
      .object({
        country: z.string().regex(/^[A-Za-z]{2}$/, 'An ISO-3166 alpha-2 country code').optional(),
        city: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const fileSearchToolSchema = z
  .object({
    type: z.literal('file_search'),
    vectorStoreIds: z.array(z.string().min(1).max(128)).min(1).max(16),
    maxResults: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const codeInterpreterToolSchema = z
  .object({
    type: z.literal('code_interpreter'),
    container: z.object({ type: z.literal('auto') }).strict().optional(),
  })
  .strict();

const imageGenerationToolSchema = z
  .object({
    type: z.literal('image_generation'),
    size: z.string().min(1).max(32).optional(),
    quality: z.string().min(1).max(16).optional(),
  })
  .strict();

const mcpToolFields = {
  type: z.literal('mcp'),
  serverLabel: z.string().regex(AI_MCP_SERVER_LABEL, 'Use 1-64 of [a-zA-Z0-9_-]'),
  serverUrl: mcpServerUrl,
  allowedTools: z.array(z.string().min(1).max(128)).max(128).optional(),
  requireApproval: z.enum(['never', 'always']).optional(),
};

const mcpToolSchema = z
  .object({
    ...mcpToolFields,
    headers: z
      .record(z.string().regex(HEADER_NAME, 'Not a valid header name'), z.string().max(8192))
      .refine((headers) => Object.keys(headers).length <= AI_MCP_MAX_HEADERS, {
        message: `At most ${AI_MCP_MAX_HEADERS} headers`,
      })
      .optional(),
  })
  .strict();

/** One hosted tool, as a request may carry it. */
export const aiHostedToolSchema = z.discriminatedUnion('type', [
  webSearchToolSchema,
  fileSearchToolSchema,
  codeInterpreterToolSchema,
  imageGenerationToolSchema,
  mcpToolSchema,
]);

/**
 * One hosted tool as STORED with a background run (`ai_runs.request`). The
 * MCP variant has no `headers` member, so the column cannot hold one: a run
 * whose MCP tool needs headers is refused by `startRun` instead.
 */
export const aiStoredHostedToolSchema = z.discriminatedUnion('type', [
  webSearchToolSchema,
  fileSearchToolSchema,
  codeInterpreterToolSchema,
  imageGenerationToolSchema,
  z.object(mcpToolFields).strict(),
]);

/** The hosted tools among a request's tools. */
export function hostedToolsOf(tools: readonly AiTool[] | undefined): AiHostedTool[] {
  return (tools ?? []).filter((tool): tool is AiHostedTool => tool.type !== 'function');
}

/**
 * Validates every hosted tool's shape. In-process callers are only
 * type-checked, so the facade runs this too. The error names the tool type
 * and the offending path — never a value (a header value is a secret).
 *
 * @throws AiError('AI_INVALID_REQUEST')
 */
export function assertHostedToolShapes(tools: readonly AiTool[] | undefined): void {
  for (const tool of hostedToolsOf(tools)) {
    const parsed = aiHostedToolSchema.safeParse(tool);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      throw new AiError('AI_INVALID_REQUEST', `The "${tool.type}" hosted tool is invalid.`, {
        details: { tool: tool.type, path: issue?.path.map(String).join('.') ?? '' },
      });
    }
  }
}

/** Lower-cased hostname of an MCP `serverUrl`, or `null` when it does not parse. */
export function mcpHost(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether `host` passes `allowed`. An empty list allows any host (the
 * `https://` rule still applies); `example.com` matches exactly that host;
 * `*.example.com` matches any subdomain of it, not the apex.
 */
export function isMcpHostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;

  const target = host.toLowerCase();

  return allowed.some((entry) => {
    const pattern = entry.trim().toLowerCase();

    if (pattern.startsWith('*.')) {
      return target.endsWith(pattern.slice(1)) && target.length > pattern.length - 1;
    }

    return target === pattern;
  });
}

/**
 * The admin policy gate: every hosted tool's type must be switched on, and an
 * MCP server's host must pass the allowlist.
 *
 * @throws AiError('AI_TOOL_DISABLED') (403)
 */
export function assertHostedToolsAllowed(
  tools: readonly AiTool[] | undefined,
  policy: AiHostedToolsPolicy,
): void {
  for (const tool of hostedToolsOf(tools)) {
    if (!policy[tool.type]) {
      throw new AiError('AI_TOOL_DISABLED', `The "${tool.type}" hosted tool is not enabled in this deployment.`, {
        details: { tool: tool.type },
      });
    }

    if (tool.type === 'mcp') {
      const host = mcpHost(tool.serverUrl);

      if (!host || !isMcpHostAllowed(host, policy.mcpAllowedHosts)) {
        throw new AiError('AI_TOOL_DISABLED', 'This MCP server host is not allowed in this deployment.', {
          details: { tool: 'mcp', host: host ?? '' },
        });
      }
    }
  }
}

/** Whether any MCP tool in `tools` carries headers. */
export function hasMcpHeaders(tools: readonly AiTool[] | undefined): boolean {
  return hostedToolsOf(tools).some(
    (tool) => tool.type === 'mcp' && Object.keys(tool.headers ?? {}).length > 0,
  );
}

/**
 * Every MCP header VALUE in `tools` worth scrubbing for (at least 4
 * characters — shorter strings would redact ordinary text and are not
 * credentials anyone could use).
 */
export function mcpHeaderValues(tools: readonly AiTool[] | undefined): string[] {
  const values = new Set<string>();

  for (const tool of hostedToolsOf(tools)) {
    if (tool.type !== 'mcp') continue;

    for (const value of Object.values((tool as AiMcpTool).headers ?? {})) {
      const trimmed = value.trim();

      if (trimmed.length >= 4) values.add(trimmed);
      // `Bearer <token>`: the token alone is the secret, and may be echoed without its scheme.
      const [, token] = /^\S+\s+(\S{4,})$/.exec(trimmed) ?? [];

      if (token) values.add(token);
    }
  }

  return [...values];
}

/** The placeholder a scrubbed secret is replaced with. */
export const AI_REDACTED = '[REDACTED]';

/**
 * `value` with every occurrence of every string in `secrets` replaced by
 * `[REDACTED]`, in every string reachable through plain objects and arrays.
 * Returns `value` itself when `secrets` is empty; otherwise a copy (binary
 * payloads are passed through untouched).
 */
export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;

  const ordered = [...secrets].sort((a, b) => b.length - a.length);

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let out = node;
      for (const secret of ordered) out = out.split(secret).join(AI_REDACTED);
      return out;
    }

    if (Array.isArray(node)) return node.map(walk);

    if (node && typeof node === 'object' && !(node instanceof Uint8Array)) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }

    return node;
  };

  return walk(value) as T;
}
