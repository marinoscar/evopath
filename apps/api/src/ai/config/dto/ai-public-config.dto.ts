import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_KEY_POLICIES } from '../../../common/schemas/settings.schema';

// =============================================================================
// GET /api/ai/config — response (issue #428, epic #419)
// =============================================================================
//
// What a signed-in user's browser needs to know about this deployment's AI
// platform, and nothing else — the `/api/notifications/config` pattern (see
// `notifications/dto/notification-config.dto.ts` for why a narrow projection
// beats widening `system_settings:read`, which the seeded Viewer and
// Contributor roles do not hold and which would hand them the whole settings
// document).
//
// It carries no key, no hint, no base URL and no admin provenance. While AI is
// off it carries no provider list either: the UI hides every AI surface, and a
// list of what would be available is not something it needs.
// =============================================================================

export const aiPublicProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Enabled in settings AND an adapter is registered in this deployment. */
  enabled: z.boolean(),
  /**
   * Whether an admin (org) key is stored for this provider. Whether it can
   * actually serve THIS user is a function of `keyPolicy`: only under
   * `byok_with_org_fallback`.
   */
  hasOrgKey: z.boolean(),
  /**
   * Whether a request may continue a conversation with `previousResponseId`
   * (#446) — `AiProviderAdapter.supportsPreviousResponseId`. `false` for a
   * provider that stores no responses (Anthropic): a client must then send
   * the conversation so far as `input` (user and assistant messages), because
   * a request naming `previousResponseId` is refused with `400
   * AI_CAPABILITY_UNSUPPORTED`.
   */
  supportsPreviousResponseId: z.boolean(),
  /**
   * Whether calling this provider needs a key (#448). `false` only for an
   * OpenAI-compatible server the administrator marked keyless
   * (`requiresKey: false`): nobody needs to add a key for it, and its calls
   * are recorded with `keySource: "none"` — a client should not prompt for one.
   */
  requiresKey: z.boolean(),
});

export const aiPublicConfigSchema = z.object({
  /** The platform kill switch. When false, hide every AI surface. */
  enabled: z.boolean(),
  keyPolicy: z.enum(AI_KEY_POLICIES),
  /**
   * `ai.defaults.allowBackgroundRuns` — whether `POST /api/ai/runs` accepts a
   * request (#433). Always false while `enabled` is false.
   */
  allowBackgroundRuns: z.boolean(),
  /**
   * `ai.defaults.allowRealtime` — whether `POST /api/ai/realtime/sessions`
   * mints a realtime voice session (#449); hide a voice mode while it is
   * false (a mint is refused `403 AI_REALTIME_DISABLED`). Always false while
   * `enabled` is false.
   */
  allowRealtime: z.boolean(),
  /**
   * Which provider-hosted tool types an administrator has switched on (#442)
   * — a client offers a tool only when its flag is true (a request naming a
   * disabled one is `403 AI_TOOL_DISABLED`). All false while `enabled` is
   * false. Booleans only: the MCP host allowlist is not published.
   */
  hostedTools: z.object({
    web_search: z.boolean(),
    file_search: z.boolean(),
    code_interpreter: z.boolean(),
    image_generation: z.boolean(),
    mcp: z.boolean(),
  }),
  /** Every registered provider; empty while `enabled` is false. */
  providers: z.array(aiPublicProviderSchema),
});

export class AiPublicConfigDto extends createZodDto(aiPublicConfigSchema) {}
export type AiPublicConfig = z.infer<typeof aiPublicConfigSchema>;
