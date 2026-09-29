import { useCallback, useEffect, useState } from 'react';
import {
  addGymEquipment,
  deleteGym,
  deleteGymEquipment,
  deleteGymPhoto,
  getGym,
  gymErrorMessage,
  isNotFound,
  setDefaultGym,
  updateGym,
  updateGymEquipment,
  updateGymPhoto,
  uploadGymPhoto,
  type EquipmentInput,
  type EquipmentUpdate,
  type GymDetail,
  type GymEquipment,
  type GymPhoto,
  type GymUpdate,
  type PhotoUpdate,
} from '../services/gyms';
import { useIsMounted } from './useIsMounted';

export interface UseGymReturn {
  gym: GymDetail | null;
  isLoading: boolean;
  /** The LOAD error only; a failed mutation rejects instead. */
  error: string | null;
  /** The load answered `404`: not the caller's gym, or deleted. */
  notFound: boolean;
  refresh: () => Promise<void>;
  update: (input: GymUpdate) => Promise<void>;
  setDefault: () => Promise<void>;
  remove: () => Promise<void>;
  addEquipment: (input: EquipmentInput) => Promise<GymEquipment>;
  updateEquipment: (equipmentId: string, input: EquipmentUpdate) => Promise<void>;
  removeEquipment: (equipmentId: string) => Promise<void>;
  /** Upload through the storage API, attach, then refetch. */
  addPhoto: (file: File) => Promise<GymPhoto>;
  updatePhoto: (photoId: string, input: PhotoUpdate) => Promise<void>;
  removePhoto: (photoId: string) => Promise<void>;
}

/**
 * E3.3. One of the caller's gyms, `GET /api/gyms/:id`, with every mutation on
 * it. Each mutation refetches the gym on success, so the page renders what the
 * API stored rather than a local guess (optimistic UI is not required).
 */
export function useGym(gymId: string | undefined): UseGymReturn {
  const [gym, setGym] = useState<GymDetail | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(gymId));
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!gymId) return;
    try {
      setIsLoading(true);
      setError(null);
      const data = await getGym(gymId);
      if (isMounted()) {
        setGym(data);
        setNotFound(false);
      }
    } catch (err) {
      if (isMounted()) {
        setNotFound(isNotFound(err));
        setError(gymErrorMessage(err, 'Failed to load this gym'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [gymId, isMounted]);

  useEffect(() => {
    setGym(null);
    void refresh();
  }, [refresh]);

  const requireId = useCallback(() => {
    if (!gymId) throw new Error('No gym selected');
    return gymId;
  }, [gymId]);

  const update = useCallback(
    async (input: GymUpdate) => {
      await updateGym(requireId(), input);
      await refresh();
    },
    [requireId, refresh],
  );

  const setDefault = useCallback(async () => {
    await setDefaultGym(requireId());
    await refresh();
  }, [requireId, refresh]);

  const remove = useCallback(async () => {
    await deleteGym(requireId());
  }, [requireId]);

  const addEquipment = useCallback(
    async (input: EquipmentInput) => {
      const row = await addGymEquipment(requireId(), input);
      await refresh();
      return row;
    },
    [requireId, refresh],
  );

  const updateEquipment = useCallback(
    async (equipmentId: string, input: EquipmentUpdate) => {
      await updateGymEquipment(requireId(), equipmentId, input);
      await refresh();
    },
    [requireId, refresh],
  );

  const removeEquipment = useCallback(
    async (equipmentId: string) => {
      await deleteGymEquipment(requireId(), equipmentId);
      await refresh();
    },
    [requireId, refresh],
  );

  const addPhoto = useCallback(
    async (file: File) => {
      const photo = await uploadGymPhoto(requireId(), file);
      await refresh();
      return photo;
    },
    [requireId, refresh],
  );

  const updatePhoto = useCallback(
    async (photoId: string, input: PhotoUpdate) => {
      await updateGymPhoto(requireId(), photoId, input);
      await refresh();
    },
    [requireId, refresh],
  );

  const removePhoto = useCallback(
    async (photoId: string) => {
      await deleteGymPhoto(requireId(), photoId);
      await refresh();
    },
    [requireId, refresh],
  );

  return {
    gym,
    isLoading,
    error,
    notFound,
    refresh,
    update,
    setDefault,
    remove,
    addEquipment,
    updateEquipment,
    removeEquipment,
    addPhoto,
    updatePhoto,
    removePhoto,
  };
}
