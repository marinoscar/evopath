/**
 * What provider-hosted tools contributed to an answer — issue #445 (API #442).
 *
 * Rendered under an assistant message from its completed response's `output`:
 *
 * - web-search CITATIONS on message items → a "Sources" list of links;
 * - `web_search` / `file_search` calls → the queries run (and, for web search,
 *   the sources consulted);
 * - `code_interpreter` calls → the code and each output as a monospace block
 *   (images it drew as links);
 * - `image_generation` calls → the image from its storage object through a
 *   signed download URL (`AiImageTile`), or a note when it could not be saved;
 * - `mcp` calls → the server, tool and its output.
 *
 * ⚠ Every URL here came from a model or a provider. Only `http(s)` URLs are
 * ever made into links (a `javascript:` citation would otherwise run on
 * click), and every link opens in a new tab with `noopener noreferrer`.
 * Text is rendered as text; nothing is interpreted as HTML.
 */
import { Box, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import type {
  AiCodeInterpreterCallResult,
  AiFileSearchCallResult,
  AiImageGenerationCallResult,
  AiOutputItem,
  AiUrlCitation,
  AiWebSearchCallResult,
} from '../../services/ai';
import { AiImageTile } from './AiImageGallery';

/** `url` when it is an absolute http(s) URL, else `null`. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Every citation across the message items, first occurrence of each URL kept. */
export function collectCitations(output: readonly AiOutputItem[] | undefined): AiUrlCitation[] {
  const seen = new Set<string>();
  const citations: AiUrlCitation[] = [];
  for (const item of output ?? []) {
    if (item.type !== 'message') continue;
    for (const citation of item.citations ?? []) {
      if (seen.has(citation.url)) continue;
      seen.add(citation.url);
      citations.push(citation);
    }
  }
  return citations;
}

function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeExternalUrl(url);
  if (!href) return <span>{children}</span>;
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" sx={{ wordBreak: 'break-word' }}>
      {children}
    </Link>
  );
}

const TOOL_LABELS: Record<string, string> = {
  web_search: 'Web search',
  file_search: 'File search',
  code_interpreter: 'Code interpreter',
  image_generation: 'Image generation',
  mcp: 'MCP',
};

const blockSx = {
  m: 0,
  p: 1,
  borderRadius: 1,
  bgcolor: 'action.hover',
  fontFamily: 'monospace',
  fontSize: '0.8125rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowX: 'auto',
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function WebSearchResult({ result }: { result: AiWebSearchCallResult }) {
  return (
    <>
      {result.queries?.length > 0 && (
        <Typography variant="body2">Searched: {result.queries.join(' · ')}</Typography>
      )}
      {result.sources?.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {result.sources.map((source, index) => (
            <li key={`${source.url}-${index}`}>
              <ExternalLink url={source.url}>{source.url}</ExternalLink>
            </li>
          ))}
        </Box>
      )}
    </>
  );
}

function FileSearchResult({ result }: { result: AiFileSearchCallResult }) {
  return (
    <>
      {result.queries?.length > 0 && (
        <Typography variant="body2">Searched: {result.queries.join(' · ')}</Typography>
      )}
      {result.results?.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {result.results.map((hit, index) => (
            <li key={index}>
              <Typography variant="body2" component="span">
                {hit.filename ?? hit.fileId ?? 'File'}
                {typeof hit.score === 'number' ? ` (score ${hit.score.toFixed(2)})` : ''}
              </Typography>
            </li>
          ))}
        </Box>
      )}
    </>
  );
}

function CodeInterpreterResult({ result }: { result: AiCodeInterpreterCallResult }) {
  return (
    <>
      {result.code && (
        <Box component="pre" aria-label="Code run" sx={blockSx}>
          {result.code}
        </Box>
      )}
      {(result.outputs ?? []).map((output, index) =>
        output.type === 'logs' ? (
          <Box key={index} component="pre" aria-label="Code output" sx={blockSx}>
            {output.logs}
          </Box>
        ) : (
          <Typography key={index} variant="body2">
            <ExternalLink url={output.url}>Image output {index + 1}</ExternalLink>
          </Typography>
        ),
      )}
    </>
  );
}

function ImageGenerationResult({ result, index }: { result: AiImageGenerationCallResult; index: number }) {
  if (!result.storageObjectId) {
    return (
      <Typography variant="body2" color="text.secondary">
        An image was generated but not saved
        {result.storageError === 'AI_STORAGE_UNAVAILABLE' ? ' — file storage is unavailable.' : '.'}
      </Typography>
    );
  }
  return (
    <Box sx={{ maxWidth: 360 }}>
      <AiImageTile
        storageObjectId={result.storageObjectId}
        mimeType={result.mimeType ?? 'image/png'}
        alt={result.revisedPrompt?.trim() || 'Image generated by the model'}
        index={index}
        revisedPrompt={result.revisedPrompt}
      />
    </Box>
  );
}

function McpResult({ result }: { result: Record<string, unknown> }) {
  const label = typeof result.serverLabel === 'string' ? result.serverLabel : 'server';
  if (result.kind === 'call') {
    return (
      <>
        <Typography variant="body2">
          {label} → {String(result.name ?? '')}
        </Typography>
        {typeof result.output === 'string' && (
          <Box component="pre" aria-label="Tool output" sx={blockSx}>
            {result.output}
          </Box>
        )}
        {typeof result.error === 'string' && (
          <Typography variant="body2" color="error">
            {result.error}
          </Typography>
        )}
      </>
    );
  }
  if (result.kind === 'list_tools' && Array.isArray(result.tools)) {
    return (
      <Typography variant="body2">
        {label} offers {result.tools.length} {result.tools.length === 1 ? 'tool' : 'tools'}
      </Typography>
    );
  }
  return <Typography variant="body2">{label}: approval requested for {String(result.name ?? 'a tool')}</Typography>;
}

function HostedCall({ item, index }: { item: Extract<AiOutputItem, { type: 'hosted_tool_call' }>; index: number }) {
  const result = item.result;
  let body: React.ReactNode = null;
  if (isObject(result)) {
    switch (item.tool) {
      case 'web_search':
        body = <WebSearchResult result={result as unknown as AiWebSearchCallResult} />;
        break;
      case 'file_search':
        body = <FileSearchResult result={result as unknown as AiFileSearchCallResult} />;
        break;
      case 'code_interpreter':
        body = <CodeInterpreterResult result={result as unknown as AiCodeInterpreterCallResult} />;
        break;
      case 'image_generation':
        body = <ImageGenerationResult result={result as unknown as AiImageGenerationCallResult} index={index} />;
        break;
      case 'mcp':
        body = <McpResult result={result} />;
        break;
      default:
        body = null;
    }
  }
  const label = TOOL_LABELS[item.tool] ?? item.tool;
  return (
    <Paper
      variant="outlined"
      role="group"
      aria-label={label}
      data-testid={`hosted-tool-${item.tool}`}
      sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Chip size="small" variant="outlined" label={item.status} color={item.status === 'failed' ? 'error' : 'default'} />
      </Box>
      {body}
    </Paper>
  );
}

export interface AiHostedToolOutputsProps {
  output: readonly AiOutputItem[] | undefined;
}

export function AiHostedToolOutputs({ output }: AiHostedToolOutputsProps) {
  const calls = (output ?? []).filter(
    (item): item is Extract<AiOutputItem, { type: 'hosted_tool_call' }> => item.type === 'hosted_tool_call',
  );
  const citations = collectCitations(output);
  if (calls.length === 0 && citations.length === 0) return null;

  return (
    <Stack spacing={1} sx={{ mt: 1, minWidth: 0 }}>
      {calls.map((item, index) => (
        <HostedCall key={item.id ?? `${item.tool}-${index}`} item={item} index={index} />
      ))}
      {citations.length > 0 && (
        <Box component="nav" aria-label="Sources">
          <Typography variant="caption" color="text.secondary" component="p">
            Sources
          </Typography>
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {citations.map((citation) => (
              <li key={citation.url}>
                <Typography variant="body2" component="span">
                  <ExternalLink url={citation.url}>{citation.title || citation.url}</ExternalLink>
                </Typography>
              </li>
            ))}
          </Box>
        </Box>
      )}
    </Stack>
  );
}

export default AiHostedToolOutputs;
