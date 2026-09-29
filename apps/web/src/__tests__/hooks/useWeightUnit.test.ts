/** `useWeightUnit` (E4.3): the Health Profile unit system as a weight unit. */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useWeightUnit } from '../../hooks/useWeightUnit';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../mocks/fixtures/health';

function serveProfile(profile: typeof mockHealthProfileEmpty) {
  server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: profile })));
}

describe('useWeightUnit', () => {
  it('is kg while the profile loads', () => {
    serveProfile(mockHealthProfileSaved);
    const { result } = renderHook(() => useWeightUnit());
    expect(result.current).toBe('kg');
  });

  it('metric reads kg, imperial reads lb', async () => {
    serveProfile(mockHealthProfileSaved);
    const { result } = renderHook(() => useWeightUnit());
    await waitFor(() => expect(result.current).toBe('lb'));
  });

  it('stays kg when the profile cannot be read', async () => {
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ message: 'no' }, { status: 403 })));
    const { result } = renderHook(() => useWeightUnit());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe('kg');
  });

  it('re-reads the profile when the window regains focus', async () => {
    serveProfile(mockHealthProfileSaved);
    const { result } = renderHook(() => useWeightUnit());
    await waitFor(() => expect(result.current).toBe('lb'));
    serveProfile(mockHealthProfileEmpty);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(result.current).toBe('kg'));
  });
});
