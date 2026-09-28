import { AiError } from '../core/ai-error';
import { AI_PROVIDER_STATE, type AiResponseRequest } from '../core/types/responses.types';
import { fromStoredRunRequest, toStoredRunRequest } from './ai-run-request';

describe('stored background-run request — hosted tools (#442)', () => {
  const base: AiResponseRequest = { model: 'm', input: 'hi' };

  it('round-trips every hosted tool type', () => {
    const tools: AiResponseRequest['tools'] = [
      { type: 'web_search', searchContextSize: 'low', userLocation: { country: 'US' } },
      { type: 'file_search', vectorStoreIds: ['vs_1'], maxResults: 3 },
      { type: 'code_interpreter', container: { type: 'auto' } },
      { type: 'image_generation', size: '1024x1024' },
      { type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com', requireApproval: 'never' },
    ];

    const stored = toStoredRunRequest('openai', { ...base, tools });

    expect(stored.tools).toEqual(tools);
    expect(fromStoredRunRequest(JSON.parse(JSON.stringify(stored))).tools).toEqual(tools);
  });

  it('refuses an MCP tool with headers — they would have to be stored', () => {
    const secret = 'Bearer never-stored-secret';

    try {
      toStoredRunRequest('openai', {
        ...base,
        tools: [
          { type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com', headers: { Authorization: secret } },
        ],
      });
      fail('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('AI_INVALID_REQUEST');
      expect(JSON.stringify(err)).not.toContain('never-stored-secret');
    }
  });

  it('an empty headers object is not a secret and is simply dropped', () => {
    const stored = toStoredRunRequest('openai', {
      ...base,
      tools: [{ type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com', headers: {} }],
    });

    expect(stored.tools).toEqual([{ type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com' }]);
  });

  it('a stored row that somehow carries headers is refused on the way back in', () => {
    const row = {
      provider: 'openai',
      model: 'm',
      input: 'hi',
      tools: [{ type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com', headers: { A: 'b' } }],
    };

    expect(() => fromStoredRunRequest(row)).toThrow(AiError);
  });
});

describe('stored background-run request — replayed history (#446)', () => {
  it('keeps replayed function calls and drops replayed reasoning (its state is in-process only)', () => {
    const stored = toStoredRunRequest('anthropic', {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { type: 'reasoning', summary: ['s'], [AI_PROVIDER_STATE]: { provider: 'anthropic', data: { signature: 'sig' } } },
        { type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' },
        { type: 'function_call_output', callId: 'c1', output: 'ok' },
      ],
    });

    expect(stored.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'ok' },
    ]);
    expect(JSON.stringify(stored)).not.toContain('sig');
    expect(fromStoredRunRequest(JSON.parse(JSON.stringify(stored))).input).toEqual(stored.input);
  });
});
