/**
 * Renders model-written markdown (CommonMark + GFM) as themed MUI typography
 * (issue #343). Built for compact surfaces such as a chat bubble: tight
 * spacing, no outer margins, long words wrap, tables and code blocks scroll
 * horizontally inside their own box rather than widening the page.
 *
 * SAFETY. Raw HTML in the source is never interpreted: without `rehype-raw`
 * react-markdown shows it escaped, as the literal text it is. Images render as their alt text (no remote loads from model
 * output), and every `href` passes `safeMarkdownHref`: only `http:`, `https:`,
 * `mailto:` and root-relative in-app paths survive; anything else renders as
 * plain text. External links open in a new tab with `noopener noreferrer`;
 * in-app paths navigate through the router.
 *
 * Partial markdown (a streaming reply with an unclosed `**`) renders as plain
 * text until the closing marker arrives; it never throws.
 */
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Box, Link, Typography, type TypographyProps } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { isExternalHref, safeMarkdownHref } from '../../utils/markdown';

export interface MarkdownTextProps {
  /** The markdown source. */
  children: string;
  /** Typography variant for body text. Default `body1`. */
  variant?: TypographyProps['variant'];
  'data-testid'?: string;
}

const REMARK_PLUGINS = [remarkGfm];

function urlTransform(url: string): string | undefined {
  return safeMarkdownHref(url);
}

function heading(variant: TypographyProps['variant'], level: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ children }: { children?: ReactNode }) {
    return (
      <Typography component={level} variant={variant} sx={{ fontWeight: 600, mt: 1.5, mb: 0.5 }}>
        {children}
      </Typography>
    );
  };
}

function buildComponents(variant: TypographyProps['variant']): Components {
  return {
    p: ({ children }) => (
      <Typography component="p" variant={variant} sx={{ my: 1, whiteSpace: 'pre-line' }}>
        {children}
      </Typography>
    ),
    h1: heading('subtitle1', 'h1'),
    h2: heading('subtitle1', 'h2'),
    h3: heading('subtitle2', 'h3'),
    h4: heading('subtitle2', 'h4'),
    h5: heading('subtitle2', 'h5'),
    h6: heading('subtitle2', 'h6'),
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      if (href.startsWith('/')) {
        return (
          <Link component={RouterLink} to={href} underline="always">
            {children}
          </Link>
        );
      }
      const external = isExternalHref(href);
      return (
        <Link
          href={href}
          underline="always"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {children}
        </Link>
      );
    },
    img: ({ alt }) => (alt ? <span>{alt}</span> : null),
    ul: ({ children }) => (
      <Box component="ul" sx={{ my: 1, pl: 2.5 }}>
        {children}
      </Box>
    ),
    ol: ({ children, start }) => (
      <Box component="ol" start={start} sx={{ my: 1, pl: 2.5 }}>
        {children}
      </Box>
    ),
    li: ({ children }) => (
      <Typography component="li" variant={variant} sx={{ my: 0.25, whiteSpace: 'pre-line' }}>
        {children}
      </Typography>
    ),
    blockquote: ({ children }) => (
      <Box
        component="blockquote"
        sx={{ my: 1, mx: 0, pl: 1.5, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' }}
      >
        {children}
      </Box>
    ),
    hr: () => <Box component="hr" sx={{ my: 1.5, border: 0, borderTop: 1, borderColor: 'divider' }} />,
    pre: ({ children }) => (
      <Box
        component="pre"
        sx={{
          my: 1,
          p: 1,
          borderRadius: 1,
          bgcolor: 'action.hover',
          overflowX: 'auto',
          fontSize: '0.8125rem',
          '& code': { p: 0, bgcolor: 'transparent', whiteSpace: 'pre', overflowWrap: 'normal' },
        }}
      >
        {children}
      </Box>
    ),
    code: ({ children }) => (
      <Box
        component="code"
        sx={{ fontFamily: 'monospace', fontSize: '0.875em', px: 0.5, py: 0.125, borderRadius: 0.5, bgcolor: 'action.hover' }}
      >
        {children}
      </Box>
    ),
    table: ({ children }) => (
      <Box sx={{ my: 1, maxWidth: '100%', overflowX: 'auto' }} data-testid="markdown-table-scroll">
        <Box
          component="table"
          sx={{
            borderCollapse: 'collapse',
            typography: 'body2',
            '& th, & td': {
              border: 1,
              borderColor: 'divider',
              px: 1,
              py: 0.5,
              textAlign: 'left',
              verticalAlign: 'top',
              overflowWrap: 'normal',
            },
            '& th': { fontWeight: 600, bgcolor: 'action.hover' },
          }}
        >
          {children}
        </Box>
      </Box>
    ),
    input: ({ checked, type }) =>
      type === 'checkbox' ? (
        <Box component="span" aria-hidden sx={{ mr: 0.5 }}>
          {checked ? '☑' : '☐'}
        </Box>
      ) : null,
  };
}

const COMPONENTS_BY_VARIANT = new Map<string, Components>();
function componentsFor(variant: TypographyProps['variant']): Components {
  const key = String(variant);
  let components = COMPONENTS_BY_VARIANT.get(key);
  if (!components) {
    components = buildComponents(variant);
    COMPONENTS_BY_VARIANT.set(key, components);
  }
  return components;
}

function MarkdownTextImpl({ children, variant = 'body1', 'data-testid': testId }: MarkdownTextProps) {
  return (
    <Box
      data-testid={testId}
      sx={{
        minWidth: 0,
        overflowWrap: 'anywhere',
        typography: variant,
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& li > p': { my: 0.25 },
        '& li > ul, & li > ol': { my: 0.25 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={componentsFor(variant)}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export const MarkdownText = memo(MarkdownTextImpl);
export default MarkdownText;
