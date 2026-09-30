/**
 * A plan's recent change log (`GET /api/programs/:id/change-log`, first page)
 * and what the E5.8 surfaces derive from it: the latest unseen AI change (the
 * "Plan adjusted" banner), the open proposal, the latest weekly review, and
 * how many AI changes the owner undid lately.
 *
 * Writes go through the API, which decides: Undo is
 * `POST /api/programs/:id/revert { changeLogId }` with `If-Match` (the latest
 * applied change only; `409 NOT_LATEST` / `TRAINING_STALE_PLAN` otherwise),
 * seen is `POST .../change-log/seen`, and a proposal is decided on its run
 * (`POST /api/ai/training/runs/:runId/decision`, which needs AI on).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listProgramChangeLog,
  markProgramChangesSeen,
  revertProgram,
  type ChangeLogEntry,
  type Program,
} from '../services/programs';
import { decideTrainingRun, type TrainingRunView } from '../services/trainingAgents';
import { useIsMounted } from './useIsMounted';

/** How far back an undo counts towards offering "Ask me first". */
export const UNDO_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Undos within the window after which the UI offers (never forces) "Ask me first". */
export const UNDOS_BEFORE_ASK_FIRST_OFFER = 2;

const PAGE = 20;

export interface UseChangeLogOptions {
  /** `false` skips every request. */
  enabled?: boolean;
}

export interface UseChangeLogReturn {
  entries: ChangeLogEntry[];
  isLoading: boolean;
  error: string | null;
  /** The newest applied AI change the owner has not seen yet. */
  unseenAiChange: ChangeLogEntry | null;
  /** The newest applied change of any kind (the only one Undo accepts). */
  latestApplied: ChangeLogEntry | null;
  /** The open proposal (`status: 'proposed'`), when there is one. */
  openProposal: ChangeLogEntry | null;
  /** The newest `reviewed` entry (a weekly review or a "no change" evaluation). */
  latestReview: ChangeLogEntry | null;
  /** AI changes undone in the last 14 days. */
  recentUndoCount: number;
  refresh: () => Promise<void>;
  /** Undo one applied change; resolves with the plan's new version. */
  undo: (entry: ChangeLogEntry) => Promise<Program>;
  /** Marks `entry` and every older one as seen. */
  markSeen: (entry: ChangeLogEntry) => Promise<void>;
  /** Approve or reject a proposal through its run. */
  decide: (entry: ChangeLogEntry, decision: 'approve' | 'reject') => Promise<TrainingRunView>;
}

/** An AI change that can be undone as the latest one. */
export function isUndoable(entry: ChangeLogEntry, latestApplied: ChangeLogEntry | null): boolean {
  return (
    entry.status === 'applied' &&
    entry.toVersion !== null &&
    entry.kind !== 'reviewed' &&
    entry.kind !== 'created' &&
    latestApplied?.id === entry.id
  );
}

export function useChangeLog(programId: string, { enabled = true }: UseChangeLogOptions = {}): UseChangeLogReturn {
  const [entries, setEntries] = useState<ChangeLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled || !programId) return;
    setIsLoading(true);
    try {
      const page = await listProgramChangeLog(programId, { limit: PAGE });
      if (isMounted()) {
        setEntries(page.items);
        setError(null);
      }
    } catch (err) {
      if (isMounted()) setError(err instanceof Error && err.message ? err.message : 'Could not load the plan changes');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted, programId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const derived = useMemo(() => {
    const latestApplied = entries.find((e) => e.status === 'applied' && e.toVersion !== null && e.kind !== 'reviewed') ?? null;
    const unseenAiChange =
      entries.find((e) => e.actor === 'ai' && e.status === 'applied' && e.kind === 'adapted' && e.seenAt === null) ?? null;
    const openProposal = entries.find((e) => e.status === 'proposed') ?? null;
    const latestReview = entries.find((e) => e.kind === 'reviewed') ?? null;
    const since = Date.now() - UNDO_WINDOW_MS;
    const recentUndoCount = entries.filter(
      (e) => e.actor === 'ai' && e.status === 'reverted' && Date.parse(e.decidedAt ?? e.createdAt) >= since,
    ).length;
    return { latestApplied, unseenAiChange, openProposal, latestReview, recentUndoCount };
  }, [entries]);

  const undo = useCallback(
    async (entry: ChangeLogEntry) => {
      const next = await revertProgram(programId, entry.toVersion ?? 0, { changeLogId: entry.id });
      await refresh();
      return next;
    },
    [programId, refresh],
  );

  const markSeen = useCallback(
    async (entry: ChangeLogEntry) => {
      await markProgramChangesSeen(programId, entry.id);
      if (!isMounted()) return;
      const seenAt = new Date().toISOString();
      const index = entries.findIndex((e) => e.id === entry.id);
      setEntries((prev) =>
        prev.map((e, i) => (index >= 0 && i >= index && e.seenAt === null ? { ...e, seenAt } : e)),
      );
    },
    [entries, isMounted, programId],
  );

  const decide = useCallback(
    async (entry: ChangeLogEntry, decision: 'approve' | 'reject') => {
      if (!entry.runId) throw new Error('This suggestion can no longer be decided.');
      const run = await decideTrainingRun(entry.runId, { decision });
      await refresh();
      return run;
    },
    [refresh],
  );

  return { entries, isLoading, error, ...derived, refresh, undo, markSeen, decide };
}
