import { AiError } from './ai-error';
import {
  AI_REDACTED,
  type AiHostedToolsPolicy,
  aiHostedToolSchema,
  aiStoredHostedToolSchema,
  assertHostedToolShapes,
  assertHostedToolsAllowed,
  hasMcpHeaders,
  isMcpHostAllowed,
  mcpHeaderValues,
  redactSecretValues,
} from './hosted-tools';
import type { AiHostedTool, AiTool } from './types/responses.types';

const allOn: AiHostedToolsPolicy = {
  web_search: true,
  file_search: true,
  code_interpreter: true,
  image_generation: true,
  mcp: true,
  mcpAllowedHosts: [],
};

const mcp = (over: Partial<Extract<AiHostedTool, { type: 'mcp' }>> = {}): AiHostedTool => ({
  type: 'mcp',
  serverLabel: 'docs',
  serverUrl: 'https://mcp.example.com/sse',
  ...over,
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AiError ? err.code : 'not-an-AiError';
  }
  return undefined;
}

describe('hosted tools (#442)', () => {
  describe('aiHostedToolSchema', () => {
    it.each<AiHostedTool>([
      { type: 'web_search' },
      { type: 'web_search', searchContextSize: 'high', userLocation: { country: 'CR', city: 'San José' } },
      { type: 'file_search', vectorStoreIds: ['vs_1'], maxResults: 5 },
      { type: 'code_interpreter' },
      { type: 'code_interpreter', container: { type: 'auto' } },
      { type: 'image_generation', size: '1024x1024', quality: 'high' },
      mcp({ allowedTools: ['search'], requireApproval: 'never', headers: { Authorization: 'Bearer abc' } }),
    ])('accepts %j', (tool) => {
      expect(aiHostedToolSchema.safeParse(tool).success).toBe(true);
    });

    it.each([
      ['an http:// MCP server', mcp({ serverUrl: 'http://mcp.example.com' })],
      ['credentials in the MCP URL', mcp({ serverUrl: 'https://user:pw@mcp.example.com' })],
      ['a bad server label', mcp({ serverLabel: 'has spaces' })],
      ['a bad header name', mcp({ headers: { 'Bad Header': 'x' } })],
      ['file search with no vector store', { type: 'file_search', vectorStoreIds: [] }],
      ['file search over 50 results', { type: 'file_search', vectorStoreIds: ['vs'], maxResults: 51 }],
      ['an unknown field', { type: 'web_search', extra: true }],
      ['a legacy options bag', { type: 'web_search', options: {} }],
    ])('refuses %s', (_label, tool) => {
      expect(aiHostedToolSchema.safeParse(tool).success).toBe(false);
    });

    it('the STORED shape cannot hold MCP headers', () => {
      expect(aiStoredHostedToolSchema.safeParse(mcp()).success).toBe(true);
      expect(aiStoredHostedToolSchema.safeParse(mcp({ headers: { A: 'b' } })).success).toBe(false);
    });
  });

  describe('assertHostedToolShapes', () => {
    it('is AI_INVALID_REQUEST naming the tool and path, never a value', () => {
      const secret = 'Bearer super-secret-value';

      try {
        assertHostedToolShapes([mcp({ serverUrl: 'http://x.example.com', headers: { Authorization: secret } })]);
        fail('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AiError);
        expect((err as AiError).code).toBe('AI_INVALID_REQUEST');
        expect((err as AiError).toJSON().details).toMatchObject({ tool: 'mcp', path: 'serverUrl' });
        expect(JSON.stringify(err)).not.toContain('super-secret-value');
      }
    });

    it('ignores function tools', () => {
      const tools = [{ type: 'function', name: 'f', description: 'd', parameters: {} }] as unknown as AiTool[];
      expect(() => assertHostedToolShapes(tools)).not.toThrow();
    });
  });

  describe('assertHostedToolsAllowed', () => {
    it.each(['web_search', 'file_search', 'code_interpreter', 'image_generation', 'mcp'] as const)(
      '%s switched off by the admin is AI_TOOL_DISABLED (403)',
      (type) => {
        const tool: AiHostedTool =
          type === 'file_search'
            ? { type, vectorStoreIds: ['vs'] }
            : type === 'mcp'
              ? mcp()
              : ({ type } as AiHostedTool);

        expect(codeOf(() => assertHostedToolsAllowed([tool], { ...allOn, [type]: false }))).toBe(
          'AI_TOOL_DISABLED',
        );
        expect(codeOf(() => assertHostedToolsAllowed([tool], allOn))).toBeUndefined();
      },
    );

    it('an MCP host outside a non-empty allowlist is AI_TOOL_DISABLED', () => {
      const policy = { ...allOn, mcpAllowedHosts: ['tools.example.org'] };

      expect(codeOf(() => assertHostedToolsAllowed([mcp()], policy))).toBe('AI_TOOL_DISABLED');
      expect(
        codeOf(() => assertHostedToolsAllowed([mcp({ serverUrl: 'https://TOOLS.example.org/mcp' })], policy)),
      ).toBeUndefined();
    });

    it('with no tools there is nothing to refuse', () => {
      const off = { ...allOn, web_search: false, mcp: false };
      expect(codeOf(() => assertHostedToolsAllowed(undefined, off))).toBeUndefined();
    });
  });

  describe('isMcpHostAllowed', () => {
    it('empty allows any host; exact entries match exactly; *. matches subdomains only', () => {
      expect(isMcpHostAllowed('anything.example', [])).toBe(true);
      expect(isMcpHostAllowed('mcp.example.com', ['mcp.example.com'])).toBe(true);
      expect(isMcpHostAllowed('evil-mcp.example.com', ['mcp.example.com'])).toBe(false);
      expect(isMcpHostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
      expect(isMcpHostAllowed('example.com', ['*.example.com'])).toBe(false);
      expect(isMcpHostAllowed('notexample.com', ['*.example.com'])).toBe(false);
    });
  });

  describe('MCP header secrets', () => {
    it('collects header values (and a bearer token on its own)', () => {
      const tools = [mcp({ headers: { Authorization: 'Bearer tok-12345', 'X-Short': 'ab' } })];

      expect(hasMcpHeaders(tools)).toBe(true);
      expect(hasMcpHeaders([mcp()])).toBe(false);
      expect(mcpHeaderValues(tools).sort()).toEqual(['Bearer tok-12345', 'tok-12345']);
    });

    it('redactSecretValues scrubs every reachable string, leaving the input untouched', () => {
      const input = { a: 'echo tok-12345!', b: ['x tok-12345', { c: 'tok-12345' }], n: 3, bytes: new Uint8Array([1]) };
      const out = redactSecretValues(input, ['tok-12345']);

      expect(out).toEqual({
        a: `echo ${AI_REDACTED}!`,
        b: [`x ${AI_REDACTED}`, { c: AI_REDACTED }],
        n: 3,
        bytes: new Uint8Array([1]),
      });
      expect(input.a).toBe('echo tok-12345!');
      expect(redactSecretValues(input, [])).toBe(input);
    });
  });
});
