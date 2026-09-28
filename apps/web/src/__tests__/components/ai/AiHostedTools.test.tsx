/**
 * Hosted tool helpers and result rendering — issue #445 (API #442).
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  buildHostedTools,
  offeredHostedTools,
  parseVectorStoreIds,
  INITIAL_HOSTED_TOOL_SELECTION,
} from '../../../components/ai/AiHostedToolControls';
import {
  AiHostedToolOutputs,
  collectCitations,
  safeExternalUrl,
} from '../../../components/ai/AiHostedToolOutputs';
import { mockPlaygroundChatModel, mockPlaygroundHostedToolsModel } from '../../mocks/fixtures/ai';
import type { AiOutputItem } from '../../../services/ai';

const ALL_ON = { web_search: true, file_search: true, code_interpreter: true, image_generation: true, mcp: true };

describe('offeredHostedTools', () => {
  it('needs the hosted_tools capability and the admin switch; never offers MCP', () => {
    expect(offeredHostedTools(mockPlaygroundHostedToolsModel, ALL_ON)).toEqual([
      'web_search',
      'file_search',
      'code_interpreter',
      'image_generation',
    ]);
    expect(offeredHostedTools(mockPlaygroundChatModel, ALL_ON)).toEqual([]);
    expect(offeredHostedTools(mockPlaygroundHostedToolsModel, undefined)).toEqual([]);
    expect(offeredHostedTools(mockPlaygroundHostedToolsModel, { ...ALL_ON, web_search: false })).not.toContain('web_search');
  });
});

describe('buildHostedTools', () => {
  it('builds only switched-on, offered tools', () => {
    const selection = { ...INITIAL_HOSTED_TOOL_SELECTION, on: { web_search: true, code_interpreter: true } };
    expect(buildHostedTools(selection, ['web_search'])).toEqual({ tools: [{ type: 'web_search' }], error: null });
  });

  it('requires vector store ids for file search and caps them at 16', () => {
    const on = { file_search: true };
    expect(buildHostedTools({ ...INITIAL_HOSTED_TOOL_SELECTION, on }, ['file_search']).error).toMatch(/at least one/);
    const many = Array.from({ length: 17 }, (_u, i) => `vs_${i}`).join(',');
    expect(buildHostedTools({ ...INITIAL_HOSTED_TOOL_SELECTION, on, vectorStoreIds: many }, ['file_search']).error).toMatch(/16/);
    expect(parseVectorStoreIds(' vs_1,vs_2\nvs_3 ')).toEqual(['vs_1', 'vs_2', 'vs_3']);
  });
});

describe('safeExternalUrl / collectCitations', () => {
  it('accepts only absolute http(s) URLs', () => {
    expect(safeExternalUrl('https://a.test/x')).toBe('https://a.test/x');
    expect(safeExternalUrl('http://a.test/')).toBe('http://a.test/');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('/relative')).toBeNull();
    expect(safeExternalUrl(42)).toBeNull();
  });

  it('dedupes citations across message items by URL', () => {
    const output: AiOutputItem[] = [
      { type: 'message', text: 'a', citations: [{ url: 'https://x.test', title: 'X', startIndex: 0, endIndex: 1 }] },
      { type: 'message', text: 'b', citations: [{ url: 'https://x.test', title: 'X again', startIndex: 0, endIndex: 1 }] },
    ];
    expect(collectCitations(output).map((c) => c.title)).toEqual(['X']);
  });
});

describe('AiHostedToolOutputs', () => {
  it('renders nothing for a plain answer', () => {
    const { container } = render(<AiHostedToolOutputs output={[{ type: 'message', text: 'hi' }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows file search hits, MCP calls and a failed status', () => {
    render(
      <AiHostedToolOutputs
        output={[
          {
            type: 'hosted_tool_call',
            tool: 'file_search',
            status: 'completed',
            result: { queries: ['q'], results: [{ filename: 'notes.pdf', score: 0.91 }] },
          },
          {
            type: 'hosted_tool_call',
            tool: 'mcp',
            status: 'failed',
            result: { kind: 'call', serverLabel: 'docs', name: 'lookup', arguments: '{}', output: 'result text', error: null },
          },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'File search' })).toHaveTextContent('notes.pdf (score 0.91)');
    const mcp = screen.getByRole('group', { name: 'MCP' });
    expect(mcp).toHaveTextContent('docs → lookup');
    expect(within(mcp).getByLabelText('Tool output')).toHaveTextContent('result text');
    expect(within(mcp).getByText('failed')).toBeInTheDocument();
  });

  it('links a code interpreter image output only when it is http(s)', () => {
    render(
      <AiHostedToolOutputs
        output={[
          {
            type: 'hosted_tool_call',
            tool: 'code_interpreter',
            status: 'completed',
            result: {
              code: null,
              containerId: 'c',
              outputs: [
                { type: 'image', url: 'https://files.test/plot.png' },
                { type: 'image', url: 'javascript:void(0)' },
              ],
            },
          },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Image output 1' })).toHaveAttribute('href', 'https://files.test/plot.png');
    expect(screen.queryByRole('link', { name: 'Image output 2' })).not.toBeInTheDocument();
    expect(screen.getByText('Image output 2')).toBeInTheDocument();
  });
});
