/**
 * The admin provider card's form model — issue #448, epic #421.
 *
 * Pure functions, no React: how one `AiAdminProvider` becomes the card's
 * editable value, how that value is checked BEFORE a save (a thin mirror of
 * the API's own rules — the API validates for real), and how it becomes that
 * provider's entry in the full-replace `PUT /admin/ai/config`.
 *
 * ⚠ The `PUT` entry carries ONLY `enabled` plus the provider's
 * `settingsFields`. A field a provider does not list is `400
 * AI_PROVIDER_FIELD_UNSUPPORTED`, so the three built-in providers (openai,
 * anthropic, gemini) keep sending exactly `{ enabled, baseUrl }`, as before.
 */
import {
  AI_AZURE_DEPLOYMENTS_MAX,
  AI_AZURE_MODEL_ID_MAX,
  AI_AZURE_NAME_PATTERN,
  aiProviderSettingsFields,
  aiProviderSettingsToInput,
} from '../../../services/ai';
import type { AiAdminProvider, AiApiStyle, AiProviderSettingsInput } from '../../../services/ai';

/** Longest base URL the form accepts. */
export const MAX_BASE_URL_LENGTH = 512;

/** One `deployments` row as typed — rows keep their order and can be half-filled. */
export interface AiDeploymentRow {
  modelId: string;
  deployment: string;
}

/** The provider's slice of the page form. Strings so "blank" (default) is representable. */
export interface AiProviderFormValue {
  enabled: boolean;
  baseUrl: string;
  /** Azure OpenAI; blank for the default. */
  apiVersion: string;
  /** `''` for the provider's default. */
  apiStyle: '' | AiApiStyle;
  /** Azure OpenAI. */
  deployments: AiDeploymentRow[];
  /** OpenAI-compatible; on unless the admin opted in to a keyless server. */
  requiresKey: boolean;
}

/** Field-level problems the card shows inline; any entry blocks Save. */
export interface AiProviderFormErrors {
  baseUrl?: string;
  apiVersion?: string;
  /** A problem with the list as a whole (too many, a duplicate model id). */
  deployments?: string;
  /** Per-row problems, by row index. */
  deploymentRows?: Record<number, { modelId?: string; deployment?: string }>;
}

/** Providers that cannot be enabled without an endpoint — mirrors the API. */
const PROVIDERS_REQUIRING_BASE_URL = new Set(['azure-openai', 'openai-compatible']);

/** Providers whose endpoint must be `https` — mirrors the API. */
const HTTPS_ONLY_PROVIDERS = new Set(['azure-openai']);

export function toProviderFormValue(provider: AiAdminProvider): AiProviderFormValue {
  return {
    enabled: provider.enabled,
    baseUrl: provider.baseUrl ?? '',
    apiVersion: provider.apiVersion ?? '',
    apiStyle: provider.apiStyle ?? '',
    deployments: Object.entries(provider.deployments ?? {}).map(([modelId, deployment]) => ({
      modelId,
      deployment,
    })),
    requiresKey: provider.requiresKey ?? true,
  };
}

export const EMPTY_PROVIDER_FORM_VALUE: AiProviderFormValue = {
  enabled: false,
  baseUrl: '',
  apiVersion: '',
  apiStyle: '',
  deployments: [],
  requiresKey: true,
};

/** Rows with both cells blank are dropped; the rest become the map. */
function deploymentsMap(rows: AiDeploymentRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const modelId = row.modelId.trim();
    const deployment = row.deployment.trim();
    if (!modelId && !deployment) continue;
    map[modelId] = deployment;
  }
  return map;
}

/** This provider's entry in the `PUT` body. Blank means omitted (the default). */
export function toProviderInput(
  provider: Pick<AiAdminProvider, 'settingsFields'>,
  value: AiProviderFormValue,
): AiProviderSettingsInput {
  return aiProviderSettingsToInput(provider, {
    enabled: value.enabled,
    baseUrl: value.baseUrl,
    apiVersion: value.apiVersion,
    apiStyle: value.apiStyle || null,
    deployments: deploymentsMap(value.deployments),
    requiresKey: value.requiresKey,
  });
}

function baseUrlError(providerId: string, text: string, enabled: boolean): string | undefined {
  const baseUrl = text.trim();
  if (!baseUrl) {
    return enabled && PROVIDERS_REQUIRING_BASE_URL.has(providerId)
      ? providerId === 'azure-openai'
        ? 'An endpoint is required to enable Azure OpenAI.'
        : 'A base URL is required to enable this provider.'
      : undefined;
  }
  if (baseUrl.length > MAX_BASE_URL_LENGTH) {
    return `Keep the base URL to ${MAX_BASE_URL_LENGTH} characters or fewer.`;
  }
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
    return HTTPS_ONLY_PROVIDERS.has(providerId)
      ? 'Must be a full https URL, e.g. https://my-resource.openai.azure.com.'
      : 'Must be a full URL, e.g. https://gateway.example.com/v1.';
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'Must be a full URL, e.g. https://gateway.example.com/v1.';
  }
  if (HTTPS_ONLY_PROVIDERS.has(providerId) && url.protocol !== 'https:') {
    return 'Azure OpenAI endpoints must use https.';
  }
  if (url.username || url.password) {
    return 'Remove the user name and password from the URL — keys are saved separately.';
  }
  if (baseUrl.includes('#')) {
    return 'Remove the #fragment from the URL.';
  }
  return undefined;
}

/** Thin client-side validation of one provider — only for the fields it renders. */
export function validateProviderForm(
  provider: Pick<AiAdminProvider, 'id' | 'settingsFields'>,
  value: AiProviderFormValue,
): AiProviderFormErrors {
  const fields = aiProviderSettingsFields(provider);
  const errors: AiProviderFormErrors = {};

  if (fields.includes('baseUrl')) {
    const error = baseUrlError(provider.id, value.baseUrl, value.enabled);
    if (error) errors.baseUrl = error;
  }

  if (fields.includes('apiVersion')) {
    const apiVersion = value.apiVersion.trim();
    if (apiVersion && !AI_AZURE_NAME_PATTERN.test(apiVersion)) {
      errors.apiVersion =
        'Letters, digits, ".", "_" and "-" only, starting with a letter or digit (at most 64), e.g. 2024-10-21.';
    }
  }

  if (fields.includes('deployments')) {
    const rows: NonNullable<AiProviderFormErrors['deploymentRows']> = {};
    const seen = new Set<string>();
    let duplicate: string | undefined;
    let filled = 0;
    value.deployments.forEach((row, index) => {
      const modelId = row.modelId.trim();
      const deployment = row.deployment.trim();
      if (!modelId && !deployment) return;
      filled += 1;
      const rowErrors: { modelId?: string; deployment?: string } = {};
      if (!modelId) rowErrors.modelId = 'Enter the model id.';
      else if (modelId.length > AI_AZURE_MODEL_ID_MAX) {
        rowErrors.modelId = `At most ${AI_AZURE_MODEL_ID_MAX} characters.`;
      } else if (seen.has(modelId)) {
        rowErrors.modelId = 'This model is already mapped.';
        duplicate = modelId;
      }
      seen.add(modelId);
      if (!deployment) rowErrors.deployment = 'Enter the deployment name.';
      else if (!AI_AZURE_NAME_PATTERN.test(deployment)) {
        rowErrors.deployment = 'Letters, digits, ".", "_" and "-" only (at most 64).';
      }
      if (rowErrors.modelId || rowErrors.deployment) rows[index] = rowErrors;
    });
    if (Object.keys(rows).length > 0) errors.deploymentRows = rows;
    if (filled > AI_AZURE_DEPLOYMENTS_MAX) {
      errors.deployments = `At most ${AI_AZURE_DEPLOYMENTS_MAX} deployments.`;
    } else if (duplicate) {
      errors.deployments = `"${duplicate}" is mapped more than once.`;
    }
  }

  return errors;
}

export function hasProviderFormErrors(errors: AiProviderFormErrors | undefined): boolean {
  return !!errors && (!!errors.baseUrl || !!errors.apiVersion || !!errors.deployments || !!errors.deploymentRows);
}
