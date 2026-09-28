import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_REALTIME_INSTRUCTIONS_MAX_CHARS } from '../../core/types/media.types';

// =============================================================================
// POST /api/ai/realtime/sessions (#449) — request and response
// =============================================================================
//
// The HTTP shape of the facade's `AiRealtimeRequest`, deliberately narrower:
// no tools (a function tool is in-process code; a browser-held session has
// nowhere to run a server's), no turn-detection or provider options — the
// browser holds the session and configures the rest itself over its data
// channel (`session.update`).
//
// `.strict()`: an unknown key is a 400 rather than silently dropped.
// ⚠ No REQUEST field can carry a key. The RESPONSE carries exactly one
// credential, `clientSecret` — the provider's ephemeral, single-session
// secret, never the caller's key (docs/specs/ai-platform.md §2.15).
// =============================================================================

export const aiRealtimeSessionRequestSchema = z
  .object({
    /** Provider id. Omit to use your default model's provider (or the only registered one). */
    provider: z.string().min(1).max(64).optional(),
    /**
     * A model with `realtime`. Omit to use the first such model available to you
     * (in `GET /api/ai/models` order).
     */
    model: z.string().min(1).max(200).optional(),
    /**
     * One of the model's voices (its `capabilities.voices` in `GET /api/ai/models`). Omit to use
     * the first it lists.
     */
    voice: z.string().min(1).max(64).optional(),
    /** Initial system instructions for the session. */
    instructions: z.string().min(1).max(AI_REALTIME_INSTRUCTIONS_MAX_CHARS).optional(),
  })
  .strict();

export class AiRealtimeSessionRequestDto extends createZodDto(aiRealtimeSessionRequestSchema) {}
export type AiRealtimeSessionRequestInput = z.output<typeof aiRealtimeSessionRequestSchema>;

export const aiRealtimeSessionResponseSchema = z.object({
  provider: z.string(),
  /** The model the session runs. */
  model: z.string(),
  /** The voice the session answers in. */
  voice: z.string(),
  /**
   * The provider's EPHEMERAL client secret (OpenAI: `ek_…`). Send it as
   * `Authorization: Bearer <clientSecret>` with the SDP offer to `connectUrl`.
   * It can open this one session configuration until `expiresAt` and call no
   * other API. It is never your API key. Do not log or store it.
   */
  clientSecret: z.string(),
  /** When `clientSecret` stops being able to OPEN a session (ISO 8601); a connected call continues. */
  expiresAt: z.iso.datetime(),
  /** Where the browser POSTs its WebRTC SDP offer (`Content-Type: application/sdp`). */
  connectUrl: z.string().url(),
});

export class AiRealtimeSessionResponseDto extends createZodDto(aiRealtimeSessionResponseSchema) {}
export type AiRealtimeSessionHttpResponse = z.output<typeof aiRealtimeSessionResponseSchema>;
