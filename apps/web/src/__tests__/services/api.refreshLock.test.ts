/**
 * Token refresh serialisation (issue #295).
 *
 * Several pages of one browser profile (tabs, or the Android TWA window plus
 * the Chrome Custom Tab used for pairing) share the HttpOnly, rotated-on-use
 * `refresh_token` cookie. The server revokes every refresh token the user
 * holds when a rotated one is presented again, so two pages must never refresh
 * at once. `ApiService.refreshToken()` dedupes within a page and takes an
 * exclusive Web Lock across pages.
 *
 * jsdom has no `navigator.locks`, so a small FIFO fake stands in for it. Two
 * `ApiService` instances sharing that fake are "two pages"; a module-level
 * variable plays the shared cookie jar, and the MSW handler plays a server
 * that rotates on use and refuses a reused token.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { APP_SLUG } from '@app/shared';
import { ApiService, AUTH_REFRESH_LOCK_NAME } from '../../services/api';

/** A minimal exclusive `LockManager`: one holder per name, FIFO waiters. */
class FakeLockManager {
  readonly requested: string[] = [];
  private tails = new Map<string, Promise<unknown>>();

  request<T>(
    name: string,
    options: { mode?: 'exclusive' | 'shared' },
    callback: () => Promise<T>,
  ): Promise<T> {
    this.requested.push(`${name}:${options.mode ?? 'exclusive'}`);
    const previous = this.tails.get(name) ?? Promise.resolve();
    const run = previous.then(
      () => callback(),
      () => callback(),
    );
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}

function installLocks(locks: FakeLockManager) {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

function removeLocks() {
  // jsdom defines no `locks`; deleting our own configurable property restores that.
  delete (navigator as unknown as { locks?: unknown }).locks;
}

/**
 * A server that rotates the refresh cookie on use and treats a second
 * presentation of a rotated cookie as reuse (401). The cookie a request
 * "presents" is the shared jar's value when the request arrives, as a browser
 * would send it.
 */
function rotatingRefreshServer(events: string[]) {
  let jar = 'rt-1';
  let issued = 1;
  const revoked = new Set<string>();

  server.use(
    http.post('*/api/auth/refresh', async () => {
      const presented = jar;
      events.push(`start:${presented}`);
      await delay(20);
      if (revoked.has(presented)) {
        events.push(`reuse:${presented}`);
        return new HttpResponse(null, { status: 401 });
      }
      revoked.add(presented);
      issued += 1;
      jar = `rt-${issued}`;
      events.push(`end:${presented}`);
      return HttpResponse.json({ data: { accessToken: `at-from-${presented}` } });
    }),
  );
}

describe('ApiService token refresh serialisation (#295)', () => {
  beforeEach(() => {
    removeLocks();
  });

  afterEach(() => {
    removeLocks();
  });

  it('names the lock from the shared identity slug', () => {
    expect(AUTH_REFRESH_LOCK_NAME).toBe(`${APP_SLUG}-auth-refresh`);
  });

  it('dedupes concurrent refreshes within one page into one network call', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/auth/refresh', async () => {
        calls += 1;
        await delay(10);
        return HttpResponse.json({ data: { accessToken: 'fresh' } });
      }),
    );
    const page = new ApiService();

    const [a, b] = await Promise.all([page.refreshToken(), page.refreshToken()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
    expect(page.getAccessToken()).toBe('fresh');
  });

  it('dedupes within a page before taking the lock, so the lock is requested once', async () => {
    const locks = new FakeLockManager();
    installLocks(locks);
    server.use(
      http.post('*/api/auth/refresh', async () => {
        await delay(10);
        return HttpResponse.json({ data: { accessToken: 'fresh' } });
      }),
    );
    const page = new ApiService();

    await Promise.all([page.refreshToken(), page.refreshToken()]);

    expect(locks.requested).toEqual([`${AUTH_REFRESH_LOCK_NAME}:exclusive`]);
  });

  it('serialises refreshes across two pages sharing navigator.locks', async () => {
    const locks = new FakeLockManager();
    installLocks(locks);
    const events: string[] = [];
    rotatingRefreshServer(events);
    const twaWindow = new ApiService();
    const customTab = new ApiService();
    twaWindow.setAccessToken('expired-a');
    customTab.setAccessToken('expired-b');

    const [a, b] = await Promise.all([twaWindow.refreshToken(), customTab.refreshToken()]);

    // The second page's request starts only after the first one finished, and
    // it presents the cookie the first rotation left in the shared jar.
    expect(events).toEqual(['start:rt-1', 'end:rt-1', 'start:rt-2', 'end:rt-2']);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(twaWindow.getAccessToken()).toBe('at-from-rt-1');
    expect(customTab.getAccessToken()).toBe('at-from-rt-2');
    expect(locks.requested).toEqual([
      `${AUTH_REFRESH_LOCK_NAME}:exclusive`,
      `${AUTH_REFRESH_LOCK_NAME}:exclusive`,
    ]);
  });

  it('without the lock, two pages refreshing at once present the same cookie (the bug)', async () => {
    const events: string[] = [];
    rotatingRefreshServer(events);
    const first = new ApiService();
    const second = new ApiService();

    const results = await Promise.all([first.refreshToken(), second.refreshToken()]);

    expect(events.slice(0, 2)).toEqual(['start:rt-1', 'start:rt-1']);
    expect(events).toContain('reuse:rt-1');
    expect(results.sort()).toEqual([false, true]);
  });

  it('still refreshes when navigator.locks is unavailable', async () => {
    expect((navigator as unknown as { locks?: unknown }).locks).toBeUndefined();
    server.use(
      http.post('*/api/auth/refresh', () =>
        HttpResponse.json({ data: { accessToken: 'no-lock-token' } }),
      ),
    );
    const page = new ApiService();

    await expect(page.refreshToken()).resolves.toBe(true);
    expect(page.getAccessToken()).toBe('no-lock-token');
  });

  it('releases the lock after a failed refresh so the next page can proceed', async () => {
    const locks = new FakeLockManager();
    installLocks(locks);
    let calls = 0;
    server.use(
      http.post('*/api/auth/refresh', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.error()
          : HttpResponse.json({ data: { accessToken: 'second' } });
      }),
    );
    const first = new ApiService();
    const second = new ApiService();

    const [a, b] = await Promise.all([first.refreshToken(), second.refreshToken()]);

    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(second.getAccessToken()).toBe('second');
  });
});
