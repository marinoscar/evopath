/**
 * GhostOverlayCamera (E7.9, #249): the last photo of the pose as a faint,
 * decorative overlay over the chosen image (or alone before one is chosen),
 * no overlay and no error without one, a switch to hide it, and a camera
 * input that opens the OS camera (`capture`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../utils/test-utils';
import {
  GhostOverlayCamera,
  GHOST_ALONE_OPACITY,
  GHOST_OPACITY,
} from '../../../components/progress/GhostOverlayCamera';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { mockProgressPhoto } from '../../mocks/fixtures/progressPhotos';

const ghost = mockProgressPhoto({ localDate: '2026-09-01', pose: 'front' });

beforeEach(() => clearPhotoUrlCache());

function renderCamera(props: Partial<Parameters<typeof GhostOverlayCamera>[0]> = {}) {
  const onFile = vi.fn();
  const onShowGhostChange = vi.fn();
  render(
    <GhostOverlayCamera
      pose="front"
      ghost={ghost}
      previewUrl={null}
      showGhost
      onShowGhostChange={onShowGhostChange}
      onFile={onFile}
      {...props}
    />,
  );
  return { onFile, onShowGhostChange };
}

describe('GhostOverlayCamera', () => {
  it('shows the last photo of the pose on its own before a photo is chosen', async () => {
    renderCamera();
    const overlay = await screen.findByTestId('ghost-overlay');
    expect(overlay).toHaveStyle({ opacity: String(GHOST_ALONE_OPACITY) });
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(/Your last front photo \(Sep 1, 2026\)/)).toBeInTheDocument();
  });

  it('lays the ghost faintly over the chosen image', async () => {
    renderCamera({ previewUrl: 'blob:chosen' });
    expect(screen.getByRole('img', { name: 'Your new front photo' })).toHaveAttribute('src', 'blob:chosen');
    expect(await screen.findByTestId('ghost-overlay')).toHaveStyle({ opacity: String(GHOST_OPACITY) });
    expect(screen.getByText(/Ghost of your last front photo/)).toBeInTheDocument();
  });

  it('has no overlay and no error without an earlier photo', () => {
    renderCamera({ ghost: null });
    expect(screen.queryByTestId('ghost-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ghost-overlay-frame')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText(/No earlier front photo yet/)).toBeInTheDocument();
  });

  it('hides the overlay when switched off', async () => {
    const user = userEvent.setup();
    const { onShowGhostChange } = renderCamera({ showGhost: false, previewUrl: 'blob:chosen' });
    expect(screen.queryByTestId('ghost-overlay')).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Show ghost overlay' }));
    expect(onShowGhostChange).toHaveBeenCalledWith(true);
  });

  it('opens the OS camera for Take photo and hands the file on', async () => {
    const user = userEvent.setup();
    const { onFile } = renderCamera();
    const camera = screen.getByTestId('progress-photo-camera-input');
    expect(camera).toHaveAttribute('capture', 'environment');
    const file = new File(['x'], 'shot.jpg', { type: 'image/jpeg' });
    await user.upload(camera, file);
    expect(onFile).toHaveBeenCalledWith(file);
  });
});
