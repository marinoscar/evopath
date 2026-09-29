import { describe, it, expect } from 'vitest';
import InboxIcon from '@mui/icons-material/Inbox';
import { render, screen } from '../../utils/test-utils';
import { EmptyState } from '../../../components/common/EmptyState';

describe('EmptyState', () => {
  it('renders the title as h2 by default', () => {
    render(<EmptyState title="Nothing yet" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing yet' })).toBeInTheDocument();
  });

  it('renders the requested heading level', () => {
    render(<EmptyState title="Nothing yet" headingLevel="h3" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing yet' })).toBeInTheDocument();
  });

  it('renders only the title when optional props are omitted', () => {
    const { container } = render(<EmptyState title="Just a title" />);
    expect(screen.getByText('Just a title')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders description and action', () => {
    render(
      <EmptyState title="T" description="Some description" action={<button>Do it</button>} />,
    );
    expect(screen.getByText('Some description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  it('marks the icon aria-hidden', () => {
    const { container } = render(<EmptyState Icon={InboxIcon} title="T" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
