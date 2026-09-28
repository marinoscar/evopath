// OpenAI hosted tools and citations (issue #442): request mapping per tool,
// output-item mapping per tool, and the stream mapper's handling of hosted
// progress events. Pure mapper tests — no transport.

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { z } from 'zod';

import type {
  AiHostedToolCallItem,
  AiResponseRequest,
  AiStreamEvent,
} from '../../core/types/responses.types';
import { classifyOpenAiModel } from './openai-model-catalog';
import { fromOpenAiOutputItem, fromOpenAiResponse, toOpenAiRequest } from './openai-responses.mapper';
import { OpenAiStreamMapper } from './openai-stream.mapper';
import {
  citedMessageItem,
  codeInterpreterCallItem,
  fileSearchCallItem,
  imageGenerationCallItem,
  mcpCallItem,
  mcpListToolsItem,
  messageItem,
  responseFixture,
  streamEventsFor,
  webSearchCallItem,
} from './testing/openai-fixtures';

const GPT4O = classifyOpenAiModel('gpt-4o');
const base: AiResponseRequest = { model: 'gpt-4o', input: 'x' };

function toolsOf(req: AiResponseRequest) {
  return toOpenAiRequest(req, GPT4O).tools;
}

describe('OpenAI hosted tools — request mapping (#442)', () => {
  it('web_search: context size and approximate location', () => {
    expect(toolsOf({ ...base, tools: [{ type: 'web_search' }] })).toEqual([{ type: 'web_search' }]);
    expect(
      toolsOf({
        ...base,
        tools: [{ type: 'web_search', searchContextSize: 'high', userLocation: { country: 'cr', city: 'San José' } }],
      }),
    ).toEqual([
      {
        type: 'web_search',
        search_context_size: 'high',
        user_location: { type: 'approximate', country: 'CR', city: 'San José' },
      },
    ]);
  });

  it('file_search: vector stores and result cap', () => {
    expect(toolsOf({ ...base, tools: [{ type: 'file_search', vectorStoreIds: ['vs_1', 'vs_2'], maxResults: 4 }] })).toEqual([
      { type: 'file_search', vector_store_ids: ['vs_1', 'vs_2'], max_num_results: 4 },
    ]);
  });

  it('code_interpreter: always an auto container', () => {
    expect(toolsOf({ ...base, tools: [{ type: 'code_interpreter' }] })).toEqual([
      { type: 'code_interpreter', container: { type: 'auto' } },
    ]);
  });

  it('image_generation: size and quality pass through', () => {
    expect(toolsOf({ ...base, tools: [{ type: 'image_generation', size: '1024x1536', quality: 'low' }] })).toEqual([
      { type: 'image_generation', size: '1024x1536', quality: 'low' },
    ]);
  });

  it('mcp: label, url, allowed tools, approval and headers', () => {
    expect(
      toolsOf({
        ...base,
        tools: [
          {
            type: 'mcp',
            serverLabel: 'docs',
            serverUrl: 'https://mcp.example.com/sse',
            allowedTools: ['search'],
            requireApproval: 'never',
            headers: { Authorization: 'Bearer t0k' },
          },
        ],
      }),
    ).toEqual([
      {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.example.com/sse',
        allowed_tools: ['search'],
        require_approval: 'never',
        headers: { Authorization: 'Bearer t0k' },
      },
    ]);
  });

  it('mixes hosted and function tools in one body', () => {
    const tools = toolsOf({
      ...base,
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'f', description: 'd', parameters: z.object({ a: z.string() }) },
      ],
    });

    expect(tools?.map((tool) => tool.type)).toEqual(['web_search', 'function']);
  });
});

describe('OpenAI hosted tools — output mapping (#442)', () => {
  it('web search call: queries and sources', () => {
    const item = fromOpenAiOutputItem(webSearchCallItem('weather paris', ['https://a.example', 'https://b.example']));

    expect(item).toMatchObject({
      type: 'hosted_tool_call',
      tool: 'web_search',
      status: 'completed',
      result: { queries: ['weather paris'], sources: [{ url: 'https://a.example' }, { url: 'https://b.example' }] },
    });
    expect((item as AiHostedToolCallItem).id).toMatch(/^ws_/);
  });

  it('web search citations land on the message, re-based across text parts', () => {
    const response = fromOpenAiResponse(
      responseFixture({
        output: [
          webSearchCallItem('q'),
          citedMessageItem([
            { text: 'Sunny. ', citations: [{ url: 'https://w.example', title: 'Weather', start: 0, end: 6 }] },
            { text: 'Mild.', citations: [{ url: 'https://m.example', title: 'Met', start: 0, end: 5 }] },
          ]),
        ],
      }),
      { request: base },
    );

    const message = response.output.find((item) => item.type === 'message');

    expect(response.outputText).toBe('Sunny. Mild.');
    expect(message).toEqual({
      type: 'message',
      text: 'Sunny. Mild.',
      citations: [
        { url: 'https://w.example', title: 'Weather', startIndex: 0, endIndex: 6 },
        { url: 'https://m.example', title: 'Met', startIndex: 7, endIndex: 12 },
      ],
    });
    expect(response.outputText.slice(7, 12)).toBe('Mild.');
  });

  it('a message without citations carries no citations key', () => {
    expect(fromOpenAiOutputItem(messageItem('plain'))).toEqual({ type: 'message', text: 'plain' });
  });

  it('file search call: queries and hits (results may be absent)', () => {
    expect(
      fromOpenAiOutputItem(fileSearchCallItem(['refund policy'], [{ file_id: 'f1', filename: 'p.pdf', score: 0.9, text: 'Refunds…' }])),
    ).toMatchObject({
      tool: 'file_search',
      result: { queries: ['refund policy'], results: [{ fileId: 'f1', filename: 'p.pdf', score: 0.9, text: 'Refunds…' }] },
    });
    expect(fromOpenAiOutputItem(fileSearchCallItem(['q'], null))).toMatchObject({ result: { queries: ['q'], results: [] } });
  });

  it('code interpreter call: code, container and outputs', () => {
    expect(fromOpenAiOutputItem(codeInterpreterCallItem('print(2+2)', '4\n', 'https://files.example/plot.png'))).toMatchObject({
      tool: 'code_interpreter',
      result: {
        code: 'print(2+2)',
        containerId: 'cntr_1',
        outputs: [
          { type: 'logs', logs: '4\n' },
          { type: 'image', url: 'https://files.example/plot.png' },
        ],
      },
    });
  });

  it('image generation call: decoded bytes + mime for the facade, no base64, no storage object yet', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const item = fromOpenAiOutputItem(
      imageGenerationCallItem(bytes, { revised_prompt: 'a red fox', size: '1024x1024', quality: 'high' }),
    ) as Extract<AiHostedToolCallItem, { tool: 'image_generation' }>;

    expect(item).toMatchObject({
      tool: 'image_generation',
      status: 'completed',
      result: {
        storageObjectId: null,
        mimeType: 'image/png',
        revisedPrompt: 'a red fox',
        size: '1024x1024',
        quality: 'high',
      },
    });
    expect(Array.from(item.result?.image?.data ?? [])).toEqual(Array.from(bytes));
    expect(item.result?.image?.mimeType).toBe('image/png');
    expect(JSON.stringify(item)).not.toContain(Buffer.from(bytes).toString('base64'));
  });

  it('image generation in jpeg maps its mime type', () => {
    const item = fromOpenAiOutputItem(imageGenerationCallItem(new Uint8Array([1]), { output_format: 'jpeg' }));

    expect(item).toMatchObject({ result: { mimeType: 'image/jpeg', image: { mimeType: 'image/jpeg' } } });
  });

  it('mcp call, failed mcp call, list tools and approval request', () => {
    expect(fromOpenAiOutputItem(mcpCallItem('search', '{"q":"x"}', 'found'))).toMatchObject({
      tool: 'mcp',
      status: 'completed',
      result: { kind: 'call', serverLabel: 'docs', name: 'search', arguments: '{"q":"x"}', output: 'found', error: null },
    });

    expect(
      fromOpenAiOutputItem(mcpCallItem('search', '{}', null, { type: 'http_error', code: 401, message: 'bad token abc' })),
    ).toMatchObject({ status: 'failed', result: { kind: 'call', error: 'http_error 401' } });

    expect(fromOpenAiOutputItem(mcpListToolsItem([{ name: 'search', description: 'Search docs' }, { name: 'fetch' }]))).toMatchObject({
      tool: 'mcp',
      status: 'completed',
      result: { kind: 'list_tools', tools: [{ name: 'search', description: 'Search docs' }, { name: 'fetch' }], error: null },
    });

    expect(
      fromOpenAiOutputItem({
        id: 'mcpr_1',
        type: 'mcp_approval_request',
        server_label: 'docs',
        name: 'delete',
        arguments: '{}',
      } as never),
    ).toEqual({
      type: 'hosted_tool_call',
      id: 'mcpr_1',
      tool: 'mcp',
      status: 'awaiting_approval',
      result: { kind: 'approval_request', serverLabel: 'docs', name: 'delete', arguments: '{}' },
    });
  });

  it('hosted calls do not make the finish reason tool_calls', () => {
    const response = fromOpenAiResponse(
      responseFixture({ output: [webSearchCallItem('q'), messageItem('done')] }),
      { request: base },
    );

    expect(response.finishReason).toBe('stop');
  });
});

describe('OpenAI hosted tools — streaming (#442)', () => {
  function run(events: ResponseStreamEvent[]): AiStreamEvent[] {
    const mapper = new OpenAiStreamMapper({ request: base, providerRequestId: 'req_1' });
    return events.flatMap((event) => mapper.map(event));
  }

  it('progress events are consumed; each hosted call surfaces once as output_item.done', () => {
    const final = responseFixture({
      output: [
        webSearchCallItem('weather'),
        citedMessageItem([{ text: 'Sunny.', citations: [{ url: 'https://w.example', title: 'W', start: 0, end: 6 }] }]),
      ],
    });
    const events = streamEventsFor(final);
    const wsId = (final.output[0] as { id: string }).id;

    // Interleave the provider's progress events after the item is added.
    const progress = ['in_progress', 'searching', 'completed'].map(
      (phase, i) =>
        ({ type: `response.web_search_call.${phase}`, item_id: wsId, output_index: 0, sequence_number: 1000 + i }) as unknown as ResponseStreamEvent,
    );
    const annotation = {
      type: 'response.output_text.annotation.added',
      item_id: 'x',
      output_index: 1,
      content_index: 0,
      annotation_index: 0,
      annotation: { type: 'url_citation' },
      sequence_number: 2000,
    } as unknown as ResponseStreamEvent;
    const addedAt = events.findIndex((e) => e.type === 'response.output_item.added');
    events.splice(addedAt + 1, 0, ...progress, annotation);

    const mapped = run(events);
    const done = mapped.filter((e): e is Extract<AiStreamEvent, { type: 'output_item.done' }> => e.type === 'output_item.done');

    expect(done.map((e) => e.item.type)).toEqual(['hosted_tool_call', 'message']);
    expect(done[0].item).toMatchObject({ tool: 'web_search', status: 'completed', result: { queries: ['weather'] } });
    expect(done[1].item).toMatchObject({ citations: [{ url: 'https://w.example', startIndex: 0, endIndex: 6 }] });

    const completed = mapped[mapped.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output).toEqual(done.map((e) => e.item));
  });
});
