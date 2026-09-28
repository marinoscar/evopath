// =============================================================================
// Azure OpenAI per-call settings (issue #448, epic #421)
// =============================================================================
//
// What `AiCallContext.providerSettings` carries for `azure-openai` (the
// `ai.providers['azure-openai']` slot minus `enabled`/`baseUrl`), read with
// defaults. The settings schema already validated the stored slot; this parse
// is the adapter's own defence against a direct caller, and it never throws —
// a malformed field falls back to its default.
// =============================================================================

import { z } from 'zod';

import {
  AI_AZURE_API_VERSION_PATTERN,
  AI_OPENAI_API_STYLES,
  type AiOpenAiApiStyle,
} from '../../../common/schemas/settings.schema';
import type { OpenAiFamily } from '../openai/openai-errors';

export const AZURE_OPENAI_PROVIDER_ID = 'azure-openai';

export const AZURE_OPENAI_FAMILY: OpenAiFamily = Object.freeze({
  providerId: AZURE_OPENAI_PROVIDER_ID,
  label: 'Azure OpenAI',
});

/**
 * The `api-version` used when the slot names none: the first GA-track
 * version to serve the Responses API, Chat Completions, embeddings and model
 * listing alike. An administrator pins another in `apiVersion`.
 */
export const AZURE_OPENAI_DEFAULT_API_VERSION = '2025-04-01-preview';

/** The wire API used when the slot names none — current api-versions serve the Responses API. */
export const AZURE_OPENAI_DEFAULT_API_STYLE: AiOpenAiApiStyle = 'responses';

export interface AzureOpenAiSettings {
  apiVersion: string;
  apiStyle: AiOpenAiApiStyle;
  /** Model id -> deployment name; empty when none is configured. */
  deployments: Readonly<Record<string, string>>;
}

const fieldSchemas = {
  apiVersion: z.string().regex(AI_AZURE_API_VERSION_PATTERN),
  apiStyle: z.enum(AI_OPENAI_API_STYLES),
  deployments: z.record(z.string(), z.string().min(1)),
};

/** The call's Azure settings, each field defaulted independently. */
export function azureOpenAiSettings(raw: Readonly<Record<string, unknown>> | undefined): AzureOpenAiSettings {
  const read = <K extends keyof typeof fieldSchemas>(key: K) => {
    const parsed = fieldSchemas[key].safeParse(raw?.[key]);

    return parsed.success ? (parsed.data as z.infer<(typeof fieldSchemas)[K]>) : undefined;
  };

  return {
    apiVersion: read('apiVersion') ?? AZURE_OPENAI_DEFAULT_API_VERSION,
    apiStyle: read('apiStyle') ?? AZURE_OPENAI_DEFAULT_API_STYLE,
    deployments: read('deployments') ?? {},
  };
}

/** The deployment a model id is served by: the configured one, else the id itself (Azure's common convention). */
export function azureDeploymentFor(settings: AzureOpenAiSettings, modelId: string): string {
  return Object.prototype.hasOwnProperty.call(settings.deployments, modelId)
    ? settings.deployments[modelId]
    : modelId;
}
