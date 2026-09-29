import { describe, it, expect } from 'vitest';
import { render, screen } from '../../utils/test-utils';
import { ComingInChip } from '../../../components/common/ComingInChip';

describe('ComingInChip', () => {
  it('renders the label for the area', () => {
    render(<ComingInChip area="gyms" />);
    expect(screen.getByText('Coming in E3')).toBeInTheDocument();
  });

  it('is not focusable', () => {
    render(<ComingInChip area="health" />);
    const chip = screen.getByText('Coming in E2').closest('.MuiChip-root') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.hasAttribute('tabindex')).toBe(false);
    expect(chip.tagName).not.toBe('BUTTON');
  });
});
