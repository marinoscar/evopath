// Request guards shared by the #448 adapters (Azure OpenAI, OpenAI-compatible),
// which declare `supportsHostedTools: false`: the runtime already refuses a
// hosted tool for them before resolving a key (the registry derives no
// `hosted_tools` capability), and this is the same refusal for a DIRECT port
// caller — the defence in depth the Anthropic mapper gives `previousResponseId`.

import { AiError } from '../../core/ai-error';
import type { AiResponseRequest } from '../../core/types/responses.types';

/** Refuses a hosted tool with `AI_CAPABILITY_UNSUPPORTED` before any call. */
export function assertNoHostedTools(req: AiResponseRequest, providerId: string): void {
  const hosted = req.tools?.find((tool) => tool.type !== 'function');

  if (hosted) {
    throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Hosted tool "${hosted.type}" is not supported by this provider.`, {
      details: { provider: providerId, tool: hosted.type, capability: 'hosted_tools' },
    });
  }
}
