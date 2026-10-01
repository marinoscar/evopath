import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { APP_NAME } from '@app/shared';
import { render } from '../../utils/test-utils';
import { AuthBrandLayout, AUTH_TAGLINE } from '../../../components/auth/AuthBrandLayout';

describe('AuthBrandLayout', () => {
  it('renders its children inside the content panel', () => {
    render(
      <AuthBrandLayout>
        <h1>Panel heading</h1>
      </AuthBrandLayout>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Panel heading' })).toBeInTheDocument();
  });

  it('shows the product name and the tagline', () => {
    render(<AuthBrandLayout>content</AuthBrandLayout>);

    expect(screen.getAllByText(APP_NAME, { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText(AUTH_TAGLINE, { ignore: '' })).toBeInTheDocument();
  });

  it('does not add a heading of its own: the brand name is a paragraph', () => {
    render(<AuthBrandLayout>content</AuthBrandLayout>);

    expect(screen.queryAllByRole('heading', { hidden: true })).toHaveLength(0);
  });

  it('renders only decorative brand marks', () => {
    const { container } = render(<AuthBrandLayout>content</AuthBrandLayout>);

    const marks = Array.from(container.querySelectorAll('svg')).filter((svg) =>
      svg.querySelector('circle'),
    );
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
