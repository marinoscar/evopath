import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PromptMessage } from '../../../components/pwa/PromptMessage';

/**
 * `PromptMessage` is the row shared by the Install and Update snackbars: a
 * decorative app-icon mark, then the message. Rendered bare, like the prompts
 * themselves (outside any provider), so `BrandMark` falls back to the default
 * MUI theme.
 */
describe('PromptMessage', () => {
  it('renders the message text', () => {
    const { getByText } = render(<PromptMessage>Install the app</PromptMessage>);

    expect(getByText('Install the app')).toBeInTheDocument();
  });

  it('keeps the message as one exact text node in its own element', () => {
    const { getByText } = render(<PromptMessage>Update available</PromptMessage>);

    expect(getByText('Update available').tagName).toBe('SPAN');
    expect(getByText('Update available').childNodes).toHaveLength(1);
  });

  it('renders the brand mark as an aria-hidden, unfocusable svg', () => {
    const { container } = render(<PromptMessage>Hello</PromptMessage>);
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
  });

  it('draws the plate variant (a rect, a road path and the sun)', () => {
    const { container } = render(<PromptMessage>Hello</PromptMessage>);
    const svg = container.querySelector('svg')!;

    expect(svg.querySelectorAll('rect')).toHaveLength(1);
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
  });

  it('exposes no image role, so the mark adds nothing to the live-region announcement', () => {
    const { queryByRole } = render(<PromptMessage>Hello</PromptMessage>);

    expect(queryByRole('img')).toBeNull();
  });
});
