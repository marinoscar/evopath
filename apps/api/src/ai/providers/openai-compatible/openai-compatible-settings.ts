// =============================================================================
// OpenAI-compatible per-call settings (issue #448, epic #421)
// =============================================================================
//
// What `AiCallContext.providerSettings` carries for `openai-compatible` (the
// slot minus `enabled`/`baseUrl`), read with defaults. Never throws: a
// malformed field falls back to its default.
// =============================================================================

import { z } from 'zod';

import { AI_OPENAI_API_STYLES, type AiOpenAiApiStyle } from '../../../common/schemas/settings.schema';
import type { OpenAiFamily } from '../openai/openai-errors';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

export const OPENAI_COMPATIBLE_FAMILY: OpenAiFamily = Object.freeze({
  providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
  label: 'The OpenAI-compatible server',
});

/** The wire API used when the slot names none: what every compatible server serves. */
export const OPENAI_COMPATIBLE_DEFAULT_API_STYLE: AiOpenAiApiStyle = 'chat_completions';

export interface OpenAiCompatibleSettings {
  apiStyle: AiOpenAiApiStyle;
  /** False only when the administrator opted in to a keyless server. */
  requiresKey: boolean;
}

export function openAiCompatibleSettings(raw: Readonly<Record<string, unknown>> | undefined): OpenAiCompatibleSettings {
  const apiStyle = z.enum(AI_OPENAI_API_STYLES).safeParse(raw?.apiStyle);

  return {
    apiStyle: apiStyle.success ? apiStyle.data : OPENAI_COMPATIBLE_DEFAULT_API_STYLE,
    requiresKey: raw?.requiresKey !== false,
  };
}
