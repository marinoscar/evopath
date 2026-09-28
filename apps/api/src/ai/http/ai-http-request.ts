// =============================================================================
// HTTP body -> facade request (issue #433, epic #419)
// =============================================================================
//
// The one place the consumer HTTP surface turns a validated body into the
// facade's `AiRequest`. Named fields only: whatever the DTO accepted is copied
// across explicitly, so a key added to the DTO later does not silently reach a
// provider without somebody deciding it should.
// =============================================================================

import type { AiRequest } from '../runtime/ai-runtime.types';
import type { AiResponseRequestInput } from './dto/ai-response-request.dto';
import { fromJsonSchemaStructuredOutput } from './json-schema-structured-output';

/** @throws AiError('AI_INVALID_REQUEST') for a structured-output schema zod cannot read. */
export function toAiRequest(body: AiResponseRequestInput): AiRequest {
  const request: AiRequest = { input: body.input };

  if (body.provider !== undefined) request.provider = body.provider;
  if (body.model !== undefined) request.model = body.model;
  if (body.instructions !== undefined) request.instructions = body.instructions;
  if (body.tools !== undefined) request.tools = body.tools;
  if (body.structuredOutput) request.structuredOutput = fromJsonSchemaStructuredOutput(body.structuredOutput);
  if (body.reasoning !== undefined) request.reasoning = body.reasoning;
  if (body.maxOutputTokens !== undefined) request.maxOutputTokens = body.maxOutputTokens;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.previousResponseId !== undefined) request.previousResponseId = body.previousResponseId;
  if (body.metadata !== undefined) request.metadata = body.metadata;
  if (body.providerOptions !== undefined) request.providerOptions = body.providerOptions;

  return request;
}
