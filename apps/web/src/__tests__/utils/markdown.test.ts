/** `stripMarkdown` and `safeMarkdownHref` (#343). */
import { describe, it, expect } from 'vitest';
import { safeMarkdownHref, stripMarkdown } from '../../utils/markdown';

describe('stripMarkdown', () => {
  it.each([
    ['You did **19 working sets**!', 'You did 19 working sets!'],
    ['__bold__ and *italic* and _under_', 'bold and italic and under'],
    ['~~old~~ new', 'old new'],
    ['Use `RPE 8` today', 'Use RPE 8 today'],
    ['## Heading\nBody', 'Heading Body'],
    ['- one\n- two\n1. three', 'one two three'],
    ['> quoted', 'quoted'],
    ['See [the guide](https://e.com) ![pic](https://e.com/p.png)', 'See the guide pic'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |', 'a · b 1 · 2'],
    ['```js\nconst x = 1\n```', 'const x = 1'],
    ['Streaming **unclosed', 'Streaming unclosed'],
    ['keep snake_case_words and 3 * 4', 'keep snake_case_words and 3 * 4'],
  ])('%j -> %j', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });

  it('returns an empty string for nothing', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
  });
});

describe('safeMarkdownHref', () => {
  it.each(['https://example.com/a?b=1', 'http://example.com', 'mailto:a@example.com', '/train?tab=1'])(
    'keeps %s',
    (href) => expect(safeMarkdownHref(href)).toBe(href),
  );

  it.each([
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,hi',
    'vbscript:x',
    'file:///etc/passwd',
    '//evil.example',
    '/\\evil.example',
    'relative/path',
    '',
    null,
    undefined,
  ])('drops %j', (href) => expect(safeMarkdownHref(href)).toBeUndefined());
});
