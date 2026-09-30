/**
 * The temporary gym of the hotel flow (E6.2): created on demand with
 * `POST /api/gyms { name, type: 'hotel', isTemporary: true }`, reloaded
 * after a scan is applied, and filled by hand through
 * `POST /api/gyms/:id/equipment`. A temporary gym is just a gym: every rule
 * (ownership, the 50-gym limit, never the default) is the API's.
 */
import { useCallback, useRef, useState } from 'react';
import {
  addGymEquipment,
  createGym,
  getGym,
  type EquipmentInput,
  type GymDetail,
} from '../services/gyms';
import { useIsMounted } from './useIsMounted';

export interface UseHotelGymReturn {
  gym: GymDetail | null;
  /** Create the temporary gym, once; later calls resolve with the same gym. Rejects on a refusal. */
  ensure: (name: string) => Promise<GymDetail>;
  /** Reload it (after a scan was applied). */
  refresh: () => Promise<GymDetail | null>;
  addEquipment: (input: EquipmentInput) => Promise<void>;
}

export function useHotelGym(initial: GymDetail | null = null): UseHotelGymReturn {
  const [gym, setGym] = useState<GymDetail | null>(initial);
  const current = useRef<GymDetail | null>(initial);
  const creating = useRef<Promise<GymDetail> | null>(null);
  const isMounted = useIsMounted();

  const keep = useCallback(
    (next: GymDetail) => {
      current.current = next;
      if (isMounted()) setGym(next);
      return next;
    },
    [isMounted],
  );

  const ensure = useCallback(
    async (name: string) => {
      if (current.current) return current.current;
      if (!creating.current) {
        creating.current = createGym({ name, type: 'hotel', isTemporary: true }).finally(() => {
          creating.current = null;
        });
      }
      return keep(await creating.current);
    },
    [keep],
  );

  const refresh = useCallback(async () => {
    if (!current.current) return null;
    return keep(await getGym(current.current.id));
  }, [keep]);

  const addEquipment = useCallback(
    async (input: EquipmentInput) => {
      if (!current.current) throw new Error('Create the gym first');
      await addGymEquipment(current.current.id, input);
      await refresh();
    },
    [refresh],
  );

  return { gym, ensure, refresh, addEquipment };
}
