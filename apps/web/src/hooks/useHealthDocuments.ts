import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  listHealthDocuments,
  type HealthDocument,
  type ListHealthDocumentsParams,
} from '../services/healthDocuments';
import { useIsMounted } from './useIsMounted';

export interface UseHealthDocumentsReturn {
  documents: HealthDocument[];
  total: number;
  isLoading: boolean;
  /** The LOAD error only; a failed rename or delete rejects its own call. */
  error: string | null;
  /** Refetch the current page, e.g. after a write or a `412`. */
  refresh: () => Promise<void>;
}

/**
 * Issue #190 (H6). One page of the caller's health documents,
 * `GET /api/health/documents`, refetched whenever `params` changes.
 *
 * Only the newest request may write state: a slow page-1 answer that lands
 * after the user moved to page 2 is dropped rather than shown under page 2's
 * controls.
 */
export function useHealthDocuments(params: ListHealthDocumentsParams): UseHealthDocumentsReturn {
  const [documents, setDocuments] = useState<HealthDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const requestSeq = useRef(0);

  const { kind, sort, order, page, pageSize } = params;

  const fetchPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    const current = () => isMounted() && seq === requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listHealthDocuments({ kind, sort, order, page, pageSize });
      if (!current()) return;
      setDocuments(result.items);
      setTotal(result.total);
    } catch (err) {
      if (!current()) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load your health documents');
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [kind, sort, order, page, pageSize, isMounted]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  return { documents, total, isLoading, error, refresh: fetchPage };
}
