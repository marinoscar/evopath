/**
 * PhotoCompare (E7.9, #249): side by side and the before/after slider, the
 * mode switch, a keyboard-operable divider, and alternative text that names
 * the date and pose only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen } from '../../utils/test-utils';
import { PhotoCompare, COMPARE_SLIDER_LABEL } from '../../../components/progress/PhotoCompare';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { mockProgressPhoto } from '../../mocks/fixtures/progressPhotos';

const before = mockProgressPhoto({ localDate: '2026-07-01', pose: 'front' });
const after = mockProgressPhoto({ localDate: '2026-09-28', pose: 'front' });

beforeEach(() => clearPhotoUrlCache());

describe('PhotoCompare', () => {
  it('shows both photos side by side with date-and-pose alt text, and switches to the slider', async () => {
    const user = userEvent.setup();
    const { container } = render(<PhotoCompare before={before} after={after} initialMode="side" />);

    expect(screen.getByTestId('compare-side-by-side')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Before: Progress photo, front pose, Jul 1, 2026' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'After: Progress photo, front pose, Sep 28, 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Slider' }));
    expect(screen.queryByTestId('compare-side-by-side')).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: COMPARE_SLIDER_LABEL })).toBeInTheDocument();
  });

  it('moves the divider from the keyboard and clips the before photo to match', async () => {
    const user = userEvent.setup();
    const { container } = render(<PhotoCompare before={before} after={after} initialMode="slider" />);
    const slider = screen.getByRole('slider', { name: COMPARE_SLIDER_LABEL });
    const layer = screen.getByTestId('compare-before-layer');

    expect(slider).toHaveAttribute('aria-valuenow', '50');
    expect(slider).toHaveAttribute('aria-valuetext', '50% before photo');
    expect(layer).toHaveStyle({ clipPath: 'inset(0 50% 0 0)' });

    slider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuenow', '52');
    expect(layer).toHaveStyle({ clipPath: 'inset(0 48% 0 0)' });

    await user.keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    await user.keyboard('{End}');
    expect(slider).toHaveAttribute('aria-valuenow', '100');
    expect(layer).toHaveStyle({ clipPath: 'inset(0 0% 0 0)' });

    expect(await screen.findByRole('img', { name: 'Before: Progress photo, front pose, Jul 1, 2026' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
