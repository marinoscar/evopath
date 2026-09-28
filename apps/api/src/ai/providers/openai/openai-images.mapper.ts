// =============================================================================
// OpenAI images mapper (issue #437, epic #420)
// =============================================================================
//
// AiImageGenerationRequest / AiImageEditRequest <-> `POST /v1/images/generations`
// and `POST /v1/images/edits`. Pure functions (plus `toFile`, which only wraps
// bytes); every failure is an `AiError`, never an SDK error.
//
// BYTES, NEVER URLS. The port's contract (`media.types.ts`) is bytes + MIME
// type: a provider-hosted URL expires and is not ours to authorize. The GPT
// image family always answers `b64_json`; the DALL·E family defaults to a
// URL, so the mapper pins `response_format: 'b64_json'` for it — and refuses
// an answer that carries only a URL rather than fetching it.
//
// TWO FAMILIES, TWO PARAMETER SETS. `gpt-image-*` (and `chatgpt-image-*`)
// take `output_format`, `background` and `quality: low|medium|high|auto`, and
// reject `response_format`. `dall-e-*` take `response_format` and reject the
// other three (DALL·E 3 names its quality `standard|hd`), so for DALL·E the
// neutral `quality: 'high'` becomes `hd` and everything the family cannot
// honour is left out rather than sent to a 400. DALL·E always returns PNG.
// =============================================================================

import { toFile } from 'openai';
import type {
  ImageEditParamsNonStreaming,
  ImageGenerateParamsNonStreaming,
  ImagesResponse,
} from 'openai/resources/images';

import { AiError } from '../../core/ai-error';
import type {
  AiBinaryPayload,
  AiGeneratedImage,
  AiImageEditRequest,
  AiImageGenerationRequest,
  AiImageResult,
} from '../../core/types/media.types';
import type { AiUsage } from '../../core/types/responses.types';
import { OPENAI_PROVIDER_ID } from './openai-errors';

const DALL_E = /^dall-e-/;
const DALL_E_3 = /^dall-e-3(?:-|$)/;

const FORMAT_MIME: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Whether OpenAI model `modelId` is a DALL·E model (URL-by-default, no output_format). */
export function isOpenAiDallE(modelId: string): boolean {
  return DALL_E.test(modelId.trim().toLowerCase());
}

type SharedImageParams = Pick<
  ImageGenerateParamsNonStreaming,
  'model' | 'prompt' | 'n' | 'size' | 'quality' | 'background' | 'output_format' | 'response_format'
>;

/** The fields generate and edit share, shaped for the model's family. */
function sharedParams(req: AiImageGenerationRequest): SharedImageParams {
  const params: SharedImageParams = { model: req.model, prompt: req.prompt };

  if (req.n !== undefined) params.n = req.n;
  if (req.size !== undefined) params.size = req.size;

  if (isOpenAiDallE(req.model)) {
    params.response_format = 'b64_json';

    if (req.quality === 'high' && DALL_E_3.test(req.model.trim().toLowerCase())) {
      params.quality = 'hd';
    }
  } else {
    if (req.quality !== undefined) params.quality = req.quality;
    if (req.background !== undefined) params.background = req.background;
    if (req.outputFormat !== undefined) params.output_format = req.outputFormat;
  }

  return params;
}

function escapeHatch(req: AiImageGenerationRequest): Record<string, unknown> {
  return (req.providerOptions?.[OPENAI_PROVIDER_ID] ?? {}) as Record<string, unknown>;
}

/** The `/v1/images/generations` body. `providerOptions.openai` merges first; the port's own fields win. */
export function toOpenAiImageGenerateRequest(req: AiImageGenerationRequest): ImageGenerateParamsNonStreaming {
  return { ...escapeHatch(req), ...sharedParams(req), stream: false };
}

function fileName(payload: AiBinaryPayload, fallback: string): string {
  if (payload.filename && payload.filename.trim().length > 0) return payload.filename;

  return `${fallback}.${MIME_EXTENSION[payload.mimeType] ?? 'png'}`;
}

/**
 * The `/v1/images/edits` multipart body. The images (and mask) become SDK
 * uploads carrying their MIME type, so OpenAI can tell a PNG from a JPEG.
 */
export async function toOpenAiImageEditRequest(req: AiImageEditRequest): Promise<ImageEditParamsNonStreaming> {
  if (!Array.isArray(req.images) || req.images.length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'An image edit needs at least one source image.', {
      details: { provider: OPENAI_PROVIDER_ID },
    });
  }

  const images = await Promise.all(
    req.images.map((image, index) =>
      toFile(image.data, fileName(image, `image-${index + 1}`), { type: image.mimeType }),
    ),
  );

  // `hd` is DALL·E 3's word, and DALL·E 3 cannot edit: never send it here.
  const { quality, ...shared } = sharedParams(req);

  const body: ImageEditParamsNonStreaming = {
    ...escapeHatch(req),
    ...shared,
    ...(quality !== undefined && quality !== 'hd' ? { quality } : {}),
    // DALL·E 2 edits exactly one image and rejects the array form.
    image: images.length === 1 && isOpenAiDallE(req.model) ? images[0] : images,
    stream: false,
  };

  if (req.mask) {
    body.mask = await toFile(req.mask.data, fileName(req.mask, 'mask'), { type: req.mask.mimeType });
  }

  return body;
}

export interface FromOpenAiImagesOptions {
  request: AiImageGenerationRequest;
  providerRequestId?: string | null;
}

function malformed(reason: string, opts: FromOpenAiImagesOptions): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', 'OpenAI returned a malformed images response.', {
    details: {
      provider: OPENAI_PROVIDER_ID,
      reason,
      ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
    },
  });
}

/** Token usage, where the GPT image family reports it (DALL·E does not). */
function imageUsage(usage: ImagesResponse['usage']): AiUsage {
  if (!usage) return {};

  const out: AiUsage = {};

  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;

  return out;
}

/**
 * The neutral result: one decoded image per `data` entry, each with the MIME
 * type of the format the provider says it produced (the request's
 * `outputFormat` when it does not say, PNG when neither does). No images, or
 * an entry with no `b64_json` (a URL-only answer), is a provider fault.
 */
export function fromOpenAiImagesResponse(data: ImagesResponse, opts: FromOpenAiImagesOptions): AiImageResult {
  const items = data.data ?? [];

  if (items.length === 0) {
    throw malformed('no_images', opts);
  }

  const format = data.output_format ?? (isOpenAiDallE(opts.request.model) ? 'png' : opts.request.outputFormat) ?? 'png';
  const mimeType = FORMAT_MIME[format] ?? 'image/png';

  const images: AiGeneratedImage[] = items.map((item) => {
    if (typeof item.b64_json !== 'string' || item.b64_json.length === 0) {
      throw malformed('missing_b64_json', opts);
    }

    const bytes = Buffer.from(item.b64_json, 'base64');

    if (bytes.length === 0) {
      throw malformed('empty_image', opts);
    }

    return {
      data: bytes,
      mimeType,
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    };
  });

  return {
    provider: OPENAI_PROVIDER_ID,
    model: opts.request.model,
    images,
    usage: imageUsage(data.usage),
    ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
  };
}
