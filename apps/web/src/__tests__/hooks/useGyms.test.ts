/**
 * `useGyms`, `useGym` and `useEquipmentTypes` (E3.3) against the stateful MSW
 * gyms API, through the real `services/gyms` client.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useGyms } from '../../hooks/useGyms';
import { useGym } from '../../hooks/useGym';
import { useCapabilities, useEquipmentTypes } from '../../hooks/useEquipmentTypes';
import { DUMBBELLS, mockGymDetail, statefulGymsApi } from '../mocks/fixtures/gyms';

describe('useGyms', () => {
  it('loads, creates (first is default), sets the default and removes', async () => {
    statefulGymsApi();
    const { result } = renderHook(() => useGyms());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.gyms).toEqual([]);

    await act(async () => {
      await result.current.create({ name: 'Home Gym', type: 'home' });
    });
    await waitFor(() => expect(result.current.gyms).toHaveLength(1));
    expect(result.current.gyms[0].isDefault).toBe(true);

    await act(async () => {
      await result.current.create({ name: 'Hotel gym', type: 'hotel', isTemporary: true });
    });
    await waitFor(() => expect(result.current.gyms).toHaveLength(2));
    const hotel = result.current.gyms.find((g) => g.name === 'Hotel gym')!;
    expect(hotel.isDefault).toBe(false);

    await act(async () => {
      await result.current.setDefault(hotel.id);
    });
    expect(result.current.gyms[0]).toMatchObject({ name: 'Hotel gym', isDefault: true });

    await act(async () => {
      await result.current.remove(hotel.id);
    });
    expect(result.current.gyms).toHaveLength(1);
    expect(result.current.gyms[0]).toMatchObject({ name: 'Home Gym', isDefault: true });
  });

  it('flags a 403 as forbidden', async () => {
    server.use(http.get('*/api/gyms', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    const { result } = renderHook(() => useGyms());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
  });

  it('asks nothing when disabled', () => {
    const { result } = renderHook(() => useGyms({ enabled: false }));
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useGym', () => {
  it('loads a gym, adds and updates equipment, refetching each time', async () => {
    const gym = mockGymDetail();
    statefulGymsApi([gym]);
    const { result } = renderHook(() => useGym(gym.id));
    await waitFor(() => expect(result.current.gym?.id).toBe(gym.id));

    await act(async () => {
      await result.current.addEquipment({ equipmentTypeId: DUMBBELLS.id, quantity: 2 });
    });
    expect(result.current.gym?.equipment).toHaveLength(1);
    const row = result.current.gym!.equipment[0];

    await act(async () => {
      await result.current.updateEquipment(row.id, { quantity: 3 });
    });
    expect(result.current.gym?.equipment[0].quantity).toBe(3);
  });

  it('reports a 404 as notFound', async () => {
    statefulGymsApi([]);
    const { result } = renderHook(() => useGym('00000000-0000-4000-8000-000000000404'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.gym).toBeNull();
  });
});

describe('useEquipmentTypes', () => {
  it('searches after the debounce', async () => {
    statefulGymsApi();
    const { result, rerender } = renderHook((props: { q: string }) => useEquipmentTypes({ q: props.q }), {
      initialProps: { q: '' },
    });
    await waitFor(() => expect(result.current.types).toHaveLength(3));
    rerender({ q: 'cross' });
    await waitFor(() => expect(result.current.types.map((t) => t.name)).toEqual(['Elliptical']));
    expect(result.current.isLoading).toBe(false);
  });

  it('asks nothing when disabled', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/equipment-types', () => {
        calls += 1;
        return HttpResponse.json({ data: [] });
      }),
    );
    renderHook(() => useEquipmentTypes({ enabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(0);
  });

  it('useCapabilities loads the capability list', async () => {
    statefulGymsApi();
    const { result } = renderHook(() => useCapabilities());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.capabilities.map((c) => c.slug)).toContain('farmer_carry');
  });
});
