/**
 * `AndroidUpdateBanner` (#287, epic #276): only inside the TWA, only when the
 * installed build is older than the hosted release, dismissal remembered per
 * versionCode, and no request at all in an ordinary browser tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { AndroidUpdateBanner, ANDROID_UPDATE_DISMISSED_KEY } from '../../../components/common/AndroidUpdateBanner';
import { captureTwaLaunch } from '../../../utils/twa';
import { mockRelease } from '../../mocks/fixtures/healthSync';

function serveRelease(versionCode = 2, versionName = '0.2.0') {
  const seen = { count: 0 };
  server.use(
    http.get('*/api/android-app/releases/latest', () => {
      seen.count += 1;
      return HttpResponse.json({ data: mockRelease({ versionCode, versionName }) });
    }),
  );
  return seen;
}

describe('AndroidUpdateBanner', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders nothing and requests nothing in an ordinary browser tab', async () => {
    const seen = serveRelease();
    const { container } = render(<AndroidUpdateBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
    expect(seen.count).toBe(0);
  });

  it('renders nothing for a TWA build that reports no version code', async () => {
    captureTwaLaunch('?source=twa');
    const seen = serveRelease();
    const { container } = render(<AndroidUpdateBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
    expect(seen.count).toBe(0);
  });

  it('shows the update inside the TWA when the installed build is older', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    serveRelease();
    render(<AndroidUpdateBanner />);
    expect(await screen.findByTestId('android-update-banner')).toHaveTextContent('Android app 0.2.0 is available.');
    expect(screen.getByRole('link', { name: 'Update' })).toHaveAttribute('href', '/settings/android-app');
  });

  it('stays hidden when the installed build is current', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.2.0&appVersionCode=2');
    const seen = serveRelease();
    const { container } = render(<AndroidUpdateBanner />);
    await waitFor(() => expect(seen.count).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden with no release published', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    // The default handler answers 404 NO_RELEASE.
    const { container } = render(<AndroidUpdateBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden on the Android app page itself', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    const seen = serveRelease();
    const { container } = render(<AndroidUpdateBanner />, { wrapperOptions: { route: '/settings/android-app' } });
    await waitFor(() => expect(seen.count).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('remembers a dismissal for that version only', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    serveRelease(2, '0.2.0');
    const user = userEvent.setup();
    const first = render(<AndroidUpdateBanner />);
    await user.click(await screen.findByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ANDROID_UPDATE_DISMISSED_KEY)).toBe('2');
    first.unmount();

    // Same version on the next launch: still dismissed.
    const again = render(<AndroidUpdateBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
    again.unmount();

    // A newer release raises it again.
    serveRelease(3, '0.3.0');
    render(<AndroidUpdateBanner />);
    expect(await screen.findByTestId('android-update-banner')).toHaveTextContent('Android app 0.3.0 is available.');
  });

  it('still works when storage is blocked', async () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    serveRelease();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    render(<AndroidUpdateBanner />);
    await user.click(await screen.findByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
  });
});
