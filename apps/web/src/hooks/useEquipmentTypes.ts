import { useCallback, useEffect, useRef, useState } from 'react';
import {
  gymErrorMessage,
  listCapabilities,
  listEquipmentTypes,
  type Capability,
  type EquipmentType,
} from '../services/gyms';
import { useIsMounted } from './useIsMounted';

/** How long the search waits after the last keystroke. */
export const EQUIPMENT_SEARCH_DEBOUNCE_MS = 250;

export interface UseEquipmentTypesOptions {
  q?: string;
  category?: string | null;
  /** `false` skips the requests (a closed dialog). */
  enabled?: boolean;
}

export interface UseEquipmentTypesReturn {
  types: EquipmentType[];
  isLoading: boolean;
  error: string | null;
  /** Re-run the current search now (after creating a custom type). */
  refresh: () => void;
}

/**
 * E3.3. `GET /api/equipment-types?q=&category=`, debounced by
 * {@link EQUIPMENT_SEARCH_DEBOUNCE_MS}. A response that arrives after a newer
 * request was sent is ignored, so a slow early search never overwrites the
 * results of a later one.
 */
export function useEquipmentTypes({
  q = '',
  category = null,
  enabled = true,
}: UseEquipmentTypesOptions = {}): UseEquipmentTypesReturn {
  const [types, setTypes] = useState<EquipmentType[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const latestRequest = useRef(0);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) return undefined;
    setIsLoading(true);
    const timer = setTimeout(() => {
      const requestId = ++latestRequest.current;
      listEquipmentTypes({ q, category: category ?? undefined })
        .then((data) => {
          if (!isMounted() || requestId !== latestRequest.current) return;
          setTypes(data);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isMounted() || requestId !== latestRequest.current) return;
          setError(gymErrorMessage(err, 'Failed to search equipment'));
        })
        .finally(() => {
          if (isMounted() && requestId === latestRequest.current) setIsLoading(false);
        });
    }, EQUIPMENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, category, enabled, nonce, isMounted]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { types, isLoading, error, refresh };
}

export interface UseCapabilitiesReturn {
  capabilities: Capability[];
  isLoading: boolean;
  error: string | null;
}

/** E3.3. `GET /api/capabilities`, for the custom-equipment editor. */
export function useCapabilities(enabled = true): UseCapabilitiesReturn {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) return;
    setIsLoading(true);
    listCapabilities()
      .then((data) => {
        if (isMounted()) {
          setCapabilities(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (isMounted()) setError(gymErrorMessage(err, 'Failed to load capabilities'));
      })
      .finally(() => {
        if (isMounted()) setIsLoading(false);
      });
  }, [enabled, isMounted]);

  return { capabilities, isLoading, error };
}
