// =============================================================================
// Hosted-tool outputs on their way out of the facade (issue #442)
// =============================================================================
//
// Every response and every stream event `AiService` returns passes through
// one `AiHostedOutputSettler`, built per provider round-trip. It does two
// things, and nothing downstream of it (HTTP bodies, SSE frames,
// `ai_runs.output`, logs) ever sees an item it has not handled:
//
//   1. IMAGE BYTES. An `image_generation` hosted call arrives from the adapter
//      carrying the generated image as bytes (`result.image`). They are handed
//      to `persistImage` — THE SEAM — and never passed on: the settled item
//      carries `storageObjectId` instead (and `mimeType`, `revisedPrompt`, …).
//      A streamed call surfaces the same item twice (its `output_item.done`,
//      then inside `response.completed`); it is settled once, by item id, and
//      the second sighting reuses the first result, so a real writer uploads
//      each image exactly once.
//
//      `AiService.persistHostedImage` is that persister: it writes the bytes
//      through the AI output writer (#437) as a user-owned storage object
//      under `ai-outputs/<userId>/<runId|responseId>/` and publishes its id
//      (or `storageObjectId: null` + `storageError` when storage is
//      unavailable). `discardHostedImage` below is the bytes-free projection
//      it starts from.
//
//   2. MCP HEADER VALUES. A remote MCP server can echo its own credential
//      back (in a tool output or an error). Every string of every settled
//      item/response/event is scrubbed of the request's MCP header values
//      (`redactSecretValues`), so a header cannot reach the wire that way
//      either.
// =============================================================================

import { redactSecretValues } from '../core/hosted-tools';
import type {
  AiHostedToolCallItem,
  AiImageGenerationCallResult,
  AiOutputItem,
  AiResponse,
  AiStreamEvent,
} from '../core/types/responses.types';

/** Who an output belongs to — what a storage writer needs to own and key it. */
export interface AiHostedOutputOwner {
  userId: string;
  /** The queue job a background run executes under, when there is one. */
  jobId?: string;
  /** The background run, when there is one — its outputs' storage folder. */
  runId?: string;
}

type ImageCall = Extract<AiHostedToolCallItem, { tool: 'image_generation' }>;

/**
 * Persists one generated image and returns the result to publish — which must
 * NOT carry `image` (the bytes).
 */
export type AiHostedImagePersister = (
  owner: AiHostedOutputOwner,
  item: ImageCall,
  responseId: string | undefined,
) => Promise<AiImageGenerationCallResult>;

/** The result minus its bytes — metadata kept, no storage object. */
export async function discardHostedImage(
  _owner: AiHostedOutputOwner,
  item: ImageCall,
): Promise<AiImageGenerationCallResult> {
  const { image: _bytes, ...rest } = item.result ?? { storageObjectId: null };

  return { ...rest, storageObjectId: rest.storageObjectId ?? null };
}

function isImageCall(item: AiOutputItem): item is ImageCall {
  return item.type === 'hosted_tool_call' && item.tool === 'image_generation';
}

export class AiHostedOutputSettler {
  /** Settled image results by provider item id — one persist per image. */
  private readonly settledImages = new Map<string, Promise<AiImageGenerationCallResult>>();
  /** The response id, once a stream has announced it. */
  private streamResponseId: string | undefined;

  constructor(
    private readonly owner: AiHostedOutputOwner,
    private readonly secrets: readonly string[],
    private readonly persistImage: AiHostedImagePersister,
  ) {}

  async item(item: AiOutputItem, responseId = this.streamResponseId): Promise<AiOutputItem> {
    let out = item;

    if (isImageCall(item) && item.result) {
      const key = item.id;
      let pending = key ? this.settledImages.get(key) : undefined;

      if (!pending) {
        pending = this.persistImage(this.owner, item, responseId);
        if (key) this.settledImages.set(key, pending);
      }

      out = { ...item, result: await pending };
    }

    return redactSecretValues(out, this.secrets);
  }

  async response(response: AiResponse): Promise<AiResponse> {
    const output: AiOutputItem[] = [];

    for (const item of response.output) {
      output.push(await this.item(item, response.id));
    }

    return redactSecretValues({ ...response, output }, this.secrets);
  }

  async event(event: AiStreamEvent): Promise<AiStreamEvent> {
    switch (event.type) {
      case 'response.created':
        this.streamResponseId = event.id;
        return event;

      case 'output_item.done':
        return { ...event, item: await this.item(event.item) };

      case 'response.completed':
        return { ...event, response: await this.response(event.response) };

      default:
        return redactSecretValues(event, this.secrets);
    }
  }
}
