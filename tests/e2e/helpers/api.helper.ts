import { expect, type Page } from '@playwright/test';
import { loginAsTestUser } from './auth.helper';

/**
 * A minimal authenticated API client for e2e setup and assertions.
 *
 * The web app keeps its short-lived access token in memory and the
 * `refresh_token` cookie is HttpOnly, so a test cannot read either directly.
 * `signIn` watches the page's own requests and remembers the newest
 * `Authorization: Bearer` header, then replays it through `page.request`
 * (which shares the page's cookie jar and `baseURL`). No refresh call is made
 * here: rotating the refresh cookie behind the page's back would log it out.
 */
export interface AuthedApi {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Any method with a JSON body (a `DELETE` that needs a typed confirmation, for one). */
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}

export type TestRole = 'admin' | 'contributor' | 'viewer';

function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: T }).data;
  return body as T;
}

export function createAuthedApi(page: Page, getToken: () => string | null): AuthedApi {
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const token = getToken();
    if (!token) throw new Error('No access token captured yet; sign in first.');
    const response = await page.request.fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      ...(body !== undefined ? { data: body } : {}),
    });
    if (!response.ok()) {
      throw new Error(`${method} ${path} failed: ${response.status()} ${await response.text()}`);
    }
    if (response.status() === 204) return undefined as T;
    const text = await response.text();
    return (text ? unwrap<T>(JSON.parse(text)) : undefined) as T;
  };

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    patch: (path, body) => call('PATCH', path, body),
    del: async (path) => {
      await call('DELETE', path);
    },
    request: (method, path, body, headers) => call(method, path, body, headers),
  };
}

let counter = 0;

/** A unique address, so every test owns its data (the test login creates the user on first use). */
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${process.pid}-${counter}@test.local`;
}

/**
 * Sign in through the test login as a fresh user of `role` and return an
 * authenticated API client for that same session.
 */
export async function signIn(
  page: Page,
  role: TestRole,
  prefix: string = role,
): Promise<{ api: AuthedApi; email: string }> {
  let token: string | null = null;
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    void request
      .allHeaders()
      .then((headers) => {
        const value = headers['authorization'];
        if (value?.startsWith('Bearer ')) token = value.slice('Bearer '.length);
      })
      .catch(() => undefined);
  });

  const email = uniqueEmail(prefix);
  await loginAsTestUser(page, { email, role });
  await expect.poll(() => token, { message: 'the app never sent an authenticated request', timeout: 15_000 }).not.toBeNull();

  return { api: createAuthedApi(page, () => token), email };
}
