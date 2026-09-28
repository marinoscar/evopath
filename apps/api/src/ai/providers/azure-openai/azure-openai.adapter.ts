// =============================================================================
// Azure OpenAI provider adapter (issue #448, epic #421)
// =============================================================================
//
// OpenAI's models behind an Azure resource (data residency, enterprise
// agreements). Azure speaks OpenAI's wire protocol, so this adapter is
// composition, not a new mapping: the OpenAI adapter's shared pieces
// (`../openai/`) with Azure's differences plugged in.
//
//   azure-openai-settings.ts        the slot's apiVersion / apiStyle / deployments
//   azure-openai-client.factory.ts  `AzureOpenAI` per call: endpoint, api-version,
//                                   `api-key` header, no redirects
//   ../openai/openai-responses.engine.ts         apiStyle 'responses' (the default)
//   ../openai/openai-chat-completions.engine.ts  apiStyle 'chat_completions'
//
// DEPLOYMENTS. Azure routes by DEPLOYMENT NAME, not model id. A request's
// model id is looked up in the slot's `deployments` map (model id ->
// deployment name) and falls back to the id itself — Azure's common
// convention of naming a deployment after its model. The deployment name is
// what goes on the wire (`model` in the body; the SDK builds
// `/deployments/<name>/...` from it for Chat Completions and embeddings);
// the model id stays what telemetry, usage and the neutral response use.
//
// MODEL LIST. `GET /openai/models` is always called (it is also how a key is
// verified). When a `deployments` map is configured, ITS KEYS are the model
// list — Azure's data plane cannot enumerate a resource's deployments, and
// the listing it does return names every model the region offers, deployed
// or not. Without a map the listing is returned as-is and the administrator
// enables what is actually deployed.
//
// CLASSIFICATION. Azure models are OpenAI models, so model ids classify with
// OpenAI's own table (`classifyOpenAiModel`) minus `hosted_tools`, which this
// adapter does not run; an id the table does not know (`gpt-35-turbo`, a
// custom map key) is `null` — unclassified — for an administrator to decide.
//
// FLAGS (static, conservative — see docs/specs/ai-platform.md §2.24):
//   - `supportsPreviousResponseId: false`. Azure's Responses API does store
//     responses, but a flag is per ADAPTER while `apiStyle` is per slot, and
//     the Chat Completions style cannot chain; declaring `false` means the
//     tool loop always resends the full history, which works in both styles.
//   - `supportsHostedTools: false`. Azure's hosted-tool coverage varies by
//     region and api-version; none is mapped. A hosted tool reaching the port
//     directly is refused with AI_CAPABILITY_UNSUPPORTED.
//
// PORTS. `responses` and `embeddings`. Images and audio are deliberately
// absent for now (their Azure routing differs per api-version); presence is
// the declaration, so the registry stays truthful.
//
// STORAGE-OBJECT INPUTS (#441). Images by `presigned_url` (Azure fetches the
// signed URL), files `inline` (base64 `file_data`) — both engines deliver
// both, and nothing is uploaded to Azure, so nothing needs deleting.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import type { AiModelCapabilities } from '../../core/capabilities';
import type {
  AiCallContext,
  AiDiscoveredModel,
  AiKeyVerification,
  AiProviderAdapter,
  AiResponsesPort,
} from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiFileInputStrategies } from '../../core/types/file-inputs.types';
import type { AiEmbeddingRequest, AiEmbeddingResult, AiEmbeddingsPort } from '../../core/types/media.types';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { OpenAiCallTelemetry } from '../openai/openai-call-telemetry';
import { OpenAiChatCompletionsEngine } from '../openai/openai-chat-completions.engine';
import { fromOpenAiEmbeddingResponse, toOpenAiEmbeddingRequest } from '../openai/openai-embeddings.mapper';
import { mapOpenAiError } from '../openai/openai-errors';
import { assertNoHostedTools } from '../openai/openai-family-guards';
import { classifyOpenAiModel } from '../openai/openai-model-catalog';
import { OpenAiResponsesEngine } from '../openai/openai-responses.engine';
import { AzureOpenAiClientFactory } from './azure-openai-client.factory';
import {
  AZURE_OPENAI_FAMILY,
  AZURE_OPENAI_PROVIDER_ID,
  azureDeploymentFor,
  azureOpenAiSettings,
} from './azure-openai-settings';

@Injectable()
export class AzureOpenAiProviderAdapter implements AiProviderAdapter, OnModuleInit {
  readonly id = AZURE_OPENAI_PROVIDER_ID;
  readonly displayName = 'Azure OpenAI';

  /** Static and conservative — see the file header. */
  readonly supportsPreviousResponseId = false;

  /** No hosted tool is mapped for Azure — see the file header. */
  readonly supportsHostedTools = false;

  /** Images by presigned URL, files inline — see the file header. */
  readonly fileInputStrategy: AiFileInputStrategies = { image: 'presigned_url', file: 'inline' };

  readonly responses: AiResponsesPort = {
    create: (req, ctx) => this.create(req, ctx),
    stream: (req, ctx) => this.stream(req, ctx),
  };

  readonly embeddings: AiEmbeddingsPort = {
    embed: (req, ctx) => this.embed(req, ctx),
  };

  private readonly logger = new Logger(AzureOpenAiProviderAdapter.name);
  private readonly telemetry = new OpenAiCallTelemetry(AZURE_OPENAI_FAMILY, this.logger);
  private readonly responsesEngine: OpenAiResponsesEngine;
  private readonly chatEngine: OpenAiChatCompletionsEngine;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly clients: AzureOpenAiClientFactory,
  ) {
    const client = (ctx: AiCallContext) => this.clients.create(ctx, azureOpenAiSettings(ctx.providerSettings));

    this.responsesEngine = new OpenAiResponsesEngine({
      family: AZURE_OPENAI_FAMILY,
      telemetry: this.telemetry,
      logger: this.logger,
      client,
      classify: (modelId) => this.classifyModel(modelId),
    });
    this.chatEngine = new OpenAiChatCompletionsEngine({
      family: AZURE_OPENAI_FAMILY,
      telemetry: this.telemetry,
      client,
      // Azure's current name for the limit, and the only one its reasoning deployments accept.
      tokenParameter: 'max_completion_tokens',
    });
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  classifyModel(modelId: string): AiModelCapabilities | null {
    const caps = classifyOpenAiModel(modelId);

    if (!caps) return null;

    return { ...caps, capabilities: caps.capabilities.filter((capability) => capability !== 'hosted_tools') };
  }

  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    return this.telemetry.call('models.list', undefined, ctx, async () => {
      const settings = azureOpenAiSettings(ctx.providerSettings);
      const client = this.clients.create(ctx, settings);
      const listed: AiDiscoveredModel[] = [];

      for await (const model of client.models.list({ signal: ctx.signal })) {
        listed.push({
          id: model.id,
          ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
          ...(typeof model.created === 'number' ? { createdAt: new Date(model.created * 1000) } : {}),
        });
      }

      const configured = Object.keys(settings.deployments);

      return configured.length > 0 ? configured.map((id) => ({ id })) : listed;
    });
  }

  /**
   * `GET /openai/models` with the key. A rejected key is an ANSWER, as is any
   * other failure — mapped to its code — so the admin UI never has to catch.
   */
  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    try {
      await this.telemetry.call('verify_key', undefined, ctx, async () => {
        await this.clients.create(ctx, azureOpenAiSettings(ctx.providerSettings)).models.list({ signal: ctx.signal });
      });

      return { ok: true };
    } catch (err) {
      const mapped = mapOpenAiError(err, AZURE_OPENAI_FAMILY);

      return mapped.code === 'AI_KEY_INVALID'
        ? { ok: false, code: 'AI_KEY_INVALID' }
        : { ok: false, code: mapped.code, detail: mapped.message };
    }
  }

  // ---- responses port -------------------------------------------------------

  private create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
    assertNoHostedTools(req, this.id);

    const settings = azureOpenAiSettings(ctx.providerSettings);
    const opts = { wireModel: azureDeploymentFor(settings, req.model) };

    return settings.apiStyle === 'chat_completions'
      ? this.chatEngine.create(req, ctx, opts)
      : this.responsesEngine.create(req, ctx, opts);
  }

  private stream(req: AiResponseRequest, ctx: AiCallContext): AsyncIterable<AiStreamEvent> {
    const settings = azureOpenAiSettings(ctx.providerSettings);
    const opts = { wireModel: azureDeploymentFor(settings, req.model) };
    const run = () =>
      settings.apiStyle === 'chat_completions'
        ? this.chatEngine.stream(req, ctx, opts)
        : this.responsesEngine.stream(req, ctx, opts);

    return (async function* () {
      assertNoHostedTools(req, AZURE_OPENAI_PROVIDER_ID);

      yield* run();
    })();
  }

  // ---- embeddings port ------------------------------------------------------

  /** `POST /openai/deployments/<deployment>/embeddings`, floats on the wire. */
  private embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult> {
    return this.telemetry.call('embeddings.create', req.model, ctx, async () => {
      const settings = azureOpenAiSettings(ctx.providerSettings);
      const body = { ...toOpenAiEmbeddingRequest(req, AZURE_OPENAI_FAMILY), model: azureDeploymentFor(settings, req.model) };

      const { data, request_id } = await this.clients
        .create(ctx, settings)
        .embeddings.create(body, { signal: ctx.signal })
        .withResponse();

      return fromOpenAiEmbeddingResponse(data, {
        request: req,
        providerRequestId: request_id,
        family: AZURE_OPENAI_FAMILY,
      });
    });
  }
}
