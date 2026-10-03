/**
 * `MarkdownText` (#343): model-written markdown rendered as themed elements,
 * with links sanitized and raw HTML shown as text, never interpreted.
 */
import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen } from '../../utils/test-utils';
import { MarkdownText } from '../../../components/common/MarkdownText';

describe('MarkdownText', () => {
  it('renders bold and italic as <strong> and <em>, without the markers', () => {
    const { container } = render(<MarkdownText>{'You did **19 working sets** and *two* PRs.'}</MarkdownText>);
    expect(container.querySelector('strong')).toHaveTextContent('19 working sets');
    expect(container.querySelector('em')).toHaveTextContent('two');
    expect(container).not.toHaveTextContent('*');
  });

  it('renders bullet and numbered lists', () => {
    render(<MarkdownText>{'Plan:\n\n- Squat\n- Bench\n\n1. Warm up\n2. Lift'}</MarkdownText>);
    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(lists[0].tagName).toBe('UL');
    expect(lists[1].tagName).toBe('OL');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Squat', 'Bench', 'Warm up', 'Lift']);
  });

  it('opens external links in a new tab with noopener noreferrer', () => {
    render(<MarkdownText>{'See [the guide](https://example.com/guide).'}</MarkdownText>);
    const link = screen.getByRole('link', { name: 'the guide' });
    expect(link).toHaveAttribute('href', 'https://example.com/guide');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps mailto links in the same tab and in-app paths on the router', () => {
    render(<MarkdownText>{'[Email](mailto:coach@example.com) or [train](/train)'}</MarkdownText>);
    const mail = screen.getByRole('link', { name: 'Email' });
    expect(mail).toHaveAttribute('href', 'mailto:coach@example.com');
    expect(mail).not.toHaveAttribute('target');
    const inApp = screen.getByRole('link', { name: 'train' });
    expect(inApp).toHaveAttribute('href', '/train');
    expect(inApp).not.toHaveAttribute('target');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    '//evil.example/login',
  ])('drops an unsafe href (%s) and renders the label as text', (href) => {
    const { container } = render(<MarkdownText>{`[click me](${href})`}</MarkdownText>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('click me')).toBeInTheDocument();
    expect(container.querySelector('[href]')).toBeNull();
  });

  it('shows raw HTML as text and never creates the element', () => {
    const { container } = render(<MarkdownText>{'<img src=x onerror=alert(1)> <script>alert(1)</script> hi'}</MarkdownText>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('renders markdown images as their alt text, with no remote load', () => {
    const { container } = render(<MarkdownText>{'![a tracking pixel](https://example.com/p.gif)'}</MarkdownText>);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('a tracking pixel');
  });

  it('renders a GFM table inside a horizontal scroll box', () => {
    render(<MarkdownText>{'| Lift | Sets |\n| --- | --- |\n| Squat | 5 |\n| Bench | 4 |'}</MarkdownText>);
    const table = screen.getByRole('table');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Lift', 'Sets']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByTestId('markdown-table-scroll')).toContainElement(table);
    expect(screen.getByTestId('markdown-table-scroll')).toHaveStyle({ overflowX: 'auto' });
  });

  it('renders inline code and fenced code blocks', () => {
    const { container } = render(<MarkdownText>{'Use `RPE 8`.\n\n```\n3x5 @ 100kg\n```'}</MarkdownText>);
    expect(container.querySelector('p code')).toHaveTextContent('RPE 8');
    expect(container.querySelector('pre code')).toHaveTextContent('3x5 @ 100kg');
  });

  it('renders partial (streaming) markdown as text without throwing', () => {
    const { container, rerender } = render(<MarkdownText>{'Great job on **19 work'}</MarkdownText>);
    expect(container).toHaveTextContent('Great job on **19 work');
    rerender(<MarkdownText>{'Great job on **19 working sets**'}</MarkdownText>);
    expect(container.querySelector('strong')).toHaveTextContent('19 working sets');
  });

  it('has no axe violations for mixed content', async () => {
    const { container } = render(
      <MarkdownText>
        {'## This week\n\n**Nice** work. See [docs](https://example.com).\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |'}
      </MarkdownText>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
