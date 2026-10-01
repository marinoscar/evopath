/**
 * `AndroidAppDownloadPage` (#287, epic #276) against MSW: the latest release,
 * the download flow (download-link first, then a real navigation), the GitHub
 * fallback with no release, and the installed-version status inside the TWA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { REPO_SLUG } from '@app/shared';
import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import AndroidAppDownloadPage, { NO_RELEASE_MESSAGE } from '../../pages/AndroidAppDownloadPage';
import { downloadNavigator } from '../../services/healthSync';
import { captureTwaLaunch } from '../../utils/twa';
import { FILE_SHA, RELEASE_ID, mockRelease } from '../mocks/fixtures/healthSync';

const DOWNLOAD_URL = '/api/android-app/download/signed-token';

function serveRelease(release = mockRelease()) {
  server.use(http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ data: release })));
}

describe('AndroidAppDownloadPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows the latest release: version, size, notes, install steps and checksum', async () => {
    serveRelease();
    render(<AndroidAppDownloadPage />);

    expect(await screen.findByRole('heading', { name: 'Version 0.2.0' })).toBeInTheDocument();
    expect(screen.getByText(/12\.3 MB/)).toBeInTheDocument();
    expect(screen.getByText('Update checks and server downloads.')).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Install steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(within(steps).getByText(window.location.origin)).toBeInTheDocument();
    expect(screen.getByTestId('release-sha256')).toHaveTextContent(FILE_SHA);
    // Outside the TWA there is no installed-version line.
    expect(screen.queryByTestId('installed-up-to-date')).not.toBeInTheDocument();
    expect(screen.queryByTestId('installed-update-available')).not.toBeInTheDocument();
  });

  it('asks for a download link, then navigates to it', async () => {
    serveRelease();
    const order: string[] = [];
    server.use(
      http.post('*/api/android-app/releases/:id/download-link', ({ params }) => {
        order.push(`link:${String(params.id)}`);
        return HttpResponse.json({ data: { url: DOWNLOAD_URL, expiresAt: '2026-10-01T00:10:00.000Z' } });
      }),
    );
    const assign = vi.spyOn(downloadNavigator, 'assign').mockImplementation((url) => {
      order.push(`assign:${url}`);
    });
    const user = userEvent.setup();
    render(<AndroidAppDownloadPage />);

    await user.click(await screen.findByRole('button', { name: /download apk/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DOWNLOAD_URL));
    expect(order).toEqual([`link:${RELEASE_ID}`, `assign:${DOWNLOAD_URL}`]);
  });

  it('shows an error and does not navigate when the link cannot be minted', async () => {
    serveRelease();
    server.use(
      http.post('*/api/android-app/releases/:id/download-link', () =>
        HttpResponse.json({ message: 'Release not found' }, { status: 404 }),
      ),
    );
    const assign = vi.spyOn(downloadNavigator, 'assign').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<AndroidAppDownloadPage />);

    await user.click(await screen.findByRole('button', { name: /download apk/i }));
    expect(await screen.findByText('Release not found')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to the GitHub release when nothing is published', async () => {
    // The default handler answers 404 NO_RELEASE.
    render(<AndroidAppDownloadPage />);
    expect(await screen.findByText(NO_RELEASE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get the android app/i })).toHaveAttribute(
      'href',
      `https://github.com/${REPO_SLUG}/releases/tag/android-latest`,
    );
    expect(screen.queryByRole('button', { name: /download apk/i })).not.toBeInTheDocument();
  });

  it('inside the TWA, says the installed build is up to date', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.2.0&appVersionCode=2');
    serveRelease();
    render(<AndroidAppDownloadPage />);
    expect(await screen.findByTestId('installed-up-to-date')).toHaveTextContent('Installed version 0.2.0 — up to date');
    expect(screen.getByRole('button', { name: /download apk/i })).toHaveClass('MuiButton-outlined');
  });

  it('inside the TWA, says an update is available and emphasizes the download', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    serveRelease();
    render(<AndroidAppDownloadPage />);
    expect(await screen.findByTestId('installed-update-available')).toHaveTextContent(
      'Update available: 0.2.0. You have 0.1.0.',
    );
    const button = screen.getByRole('button', { name: /download apk/i });
    expect(button).toHaveClass('MuiButton-contained');
    expect(button).toHaveClass('MuiButton-colorWarning');
  });
});
