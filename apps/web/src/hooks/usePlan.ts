/**
 * One plan (`GET /api/programs/:id`) with its lifecycle actions. Every
 * content write sends the loaded `currentVersion` as `If-Match`; a stale one
 * answers `409 TRAINING_STALE_PLAN`, which the caller shows as "this plan
 * changed elsewhere". Each successful write replaces the loaded plan with
 * the API's answer (the new version).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  activateProgram,
  archiveProgram,
  deleteProgram,
  duplicateProgram,
  getProgram,
  pauseProgram,
  replaceProgramStructure,
  resumeProgramAutonomy,
  revertProgram,
  updateProgram,
  type PlanTree,
  type Program,
  type UpdateProgramInput,
} from '../services/programs';
import { useIsMounted } from './useIsMounted';

export interface UsePlanReturn {
  program: Program | null;
  isLoading: boolean;
  error: string | null;
  notFound: boolean;
  refresh: () => Promise<Program | null>;
  /** `PUT /structure` with `If-Match: currentVersion`; resolves with the new version. */
  saveStructure: (tree: PlanTree) => Promise<Program>;
  updateHeader: (input: UpdateProgramInput) => Promise<Program>;
  activate: (startDate: string) => Promise<Program>;
  pause: () => Promise<Program>;
  archive: () => Promise<Program>;
  duplicate: () => Promise<Program>;
  remove: () => Promise<void>;
  revertTo: (toVersion: number) => Promise<Program>;
  /** Clears a paused plan's automatic adjustments (E5.8). */
  resumeAutonomy: () => Promise<Program>;
}

export function usePlan(programId: string): UsePlanReturn {
  const [program, setProgram] = useState<Program | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const loaded = await getProgram(programId);
      if (isMounted()) {
        setProgram(loaded);
        setError(null);
        setNotFound(false);
      }
      return loaded;
    } catch (err) {
      if (isMounted()) {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        setError(err instanceof Error && err.message ? err.message : 'Could not load the plan');
      }
      return null;
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, programId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(
    async (write: () => Promise<Program>) => {
      const next = await write();
      if (isMounted()) setProgram(next);
      return next;
    },
    [isMounted],
  );

  const version = program?.currentVersion ?? 0;
  const saveStructure = useCallback(
    (tree: PlanTree) => apply(() => replaceProgramStructure(programId, version, tree)),
    [apply, programId, version],
  );
  const revertTo = useCallback(
    (toVersion: number) => apply(() => revertProgram(programId, version, { toVersion })),
    [apply, programId, version],
  );

  return {
    program,
    isLoading,
    error,
    notFound,
    refresh,
    saveStructure,
    revertTo,
    updateHeader: (input) => apply(() => updateProgram(programId, input)),
    activate: (startDate) => apply(() => activateProgram(programId, startDate)),
    pause: () => apply(() => pauseProgram(programId)),
    resumeAutonomy: () => apply(() => resumeProgramAutonomy(programId)),
    archive: () => apply(() => archiveProgram(programId)),
    duplicate: () => duplicateProgram(programId),
    remove: () => deleteProgram(programId),
  };
}
