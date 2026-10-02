/**
 * A refused session refresh sends the user to sign in (issue #295).
 *
 * Before: a page whose `POST /auth/refresh` was refused (for example after the
 * server's reuse detection revoked the user's refresh tokens) kept its expired
 * access token, and every widget rendered its own "Unauthorized". Now the API
 * client emits a session-expired event, `AuthProvider` clears the session, and
 * `ProtectedRoute` redirects to `/login`, where the notice explains why.
 *
 * These tests mount the REAL `AuthProvider`, `ProtectedRoute` and `LoginPage`
 * against MSW, because the redirect is the product of all three.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useEffect, useState } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { server } from '../mocks/server';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import { ProtectedRoute } from '../../components/common/ProtectedRoute';
import LoginPage from '../../pages/LoginPage';
import { api, ApiError, ApiService } from '../../services/api';

vi.mock('../../services/pushSubscription', () => ({
  removePushSubscription: vi.fn().mockResolvedValue(undefined),
}));

/** A protected widget that loads data the way every card does. */
function Widget() {
  const [state, setState] = useState('loading');
  useEffect(() => {
    api
      .get<{ ok: boolean }>('/widget')
      .then(() => setState('loaded'))
      .catch((error: unknown) =>
        setState(error instanceof ApiError ? error.message : 'failed'),
      );
  }, []);
  return <div data-testid="widget">{state}</div>;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeContextProvider>
        <AuthProvider>
          <LocationProbe />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Widget />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeContextProvider>
    </MemoryRouter>,
  );
}

describe('session expiry redirect (#295)', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    sessionStorage.clear();
  });

  afterEach(() => {
    api.setAccessToken(null);
  });

  it('navigates to /login with the session-expired notice when /auth/refresh returns 401', async () => {
    let refreshCalls = 0;
    server.use(
      // Boot: the first refresh succeeds and signs the page in. Every later
      // one is refused, as after the server revoked the refresh tokens.
      http.post('*/api/auth/refresh', () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? HttpResponse.json({ data: { accessToken: 'boot-token' } })
          : new HttpResponse(null, { status: 401 });
      }),
      // The access token has expired by the time the widget loads.
      http.get('*/api/widget', () => new HttpResponse(null, { status: 401 })),
    );

    renderApp('/');

    expect(await screen.findByTestId('session-expired-notice')).toHaveTextContent(
      /your session expired\. please sign in again\./i,
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
    expect(screen.queryByTestId('widget')).not.toBeInTheDocument();
    expect(api.getAccessToken()).toBeNull();

    // No refresh-redirect loop: the login page itself triggers nothing more.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshCalls).toBe(2);
  });

  it('also treats a 403 from /auth/refresh as an expired session', async () => {
    let refreshCalls = 0;
    server.use(
      http.post('*/api/auth/refresh', () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? HttpResponse.json({ data: { accessToken: 'boot-token' } })
          : new HttpResponse(null, { status: 403 });
      }),
      http.get('*/api/widget', () => new HttpResponse(null, { status: 401 })),
    );

    renderApp('/');

    expect(await screen.findByTestId('session-expired-notice')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('shows no notice when a visitor who never signed in opens the login page', async () => {
    let refreshCalls = 0;
    server.use(
      http.post('*/api/auth/refresh', () => {
        refreshCalls += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    renderApp('/login');

    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
    expect(screen.queryByTestId('session-expired-notice')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshCalls).toBe(1);
  });

  it('redirects an unauthenticated visit to a protected page without the notice', async () => {
    server.use(
      http.post('*/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    );

    renderApp('/');

    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
    expect(screen.queryByTestId('session-expired-notice')).not.toBeInTheDocument();
  });
});

describe('ApiService.onSessionExpired (#295)', () => {
  it('fires when a refresh is refused while the page held an access token', async () => {
    server.use(
      http.post('*/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    );
    const client = new ApiService();
    const listener = vi.fn();
    client.onSessionExpired(listener);
    client.setAccessToken('expired');

    await expect(client.refreshToken()).resolves.toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.getAccessToken()).toBeNull();
  });

  it('does not fire when the page held no access token', async () => {
    server.use(
      http.post('*/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    );
    const client = new ApiService();
    const listener = vi.fn();
    client.onSessionExpired(listener);

    await client.refreshToken();

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not fire for a network failure or a server error', async () => {
    const client = new ApiService();
    const listener = vi.fn();
    client.onSessionExpired(listener);

    server.use(http.post('*/api/auth/refresh', () => HttpResponse.error()));
    client.setAccessToken('expired');
    await client.refreshToken();

    server.use(
      http.post('*/api/auth/refresh', () => new HttpResponse(null, { status: 500 })),
    );
    client.setAccessToken('expired');
    await client.refreshToken();

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    server.use(
      http.post('*/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    );
    const client = new ApiService();
    const listener = vi.fn();
    const unsubscribe = client.onSessionExpired(listener);
    unsubscribe();
    client.setAccessToken('expired');

    await client.refreshToken();

    expect(listener).not.toHaveBeenCalled();
  });
});
