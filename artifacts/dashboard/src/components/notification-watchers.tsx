import { useEffect, useRef } from "react";
import {
  useListSessions,
  useGetBatchRepoStatus,
  useGetSessionConflicts,
  useGetSessionCoordination,
  getGetBatchRepoStatusQueryKey,
  getGetSessionConflictsQueryKey,
  getGetSessionCoordinationQueryKey,
  getListSessionsQueryKey,
} from "@workspace/api-client-react";
import type { Session } from "@workspace/api-client-react";
import { addNotification } from "@/lib/notification-store";
import { useSwarmStatus } from "@/components/swarm-activity-panel";

/**
 * Watches the global session list and emits notifications for status
 * transitions (running/starting → ready, anything → error). Mounted once
 * inside AppLayout so notifications fire regardless of the current page.
 *
 * Transitions are detected against the previous poll. On first load we
 * seed the ref without firing notifications (avoid retroactive spam for
 * sessions that were already in their final state before mount).
 */
export function SessionStatusWatcher() {
  const { data: sessions } = useListSessions({
    query: { refetchInterval: 10000, queryKey: getListSessionsQueryKey() },
  });
  const prevStatusRef = useRef<Map<number, string> | null>(null);

  useEffect(() => {
    if (!sessions) return;
    const prev = prevStatusRef.current;
    const next = new Map<number, string>();
    for (const s of sessions) next.set(s.id, s.status);

    if (prev !== null) {
      for (const s of sessions) {
        const before = prev.get(s.id);
        if (before === s.status) continue;
        if (
          s.status === "ready" &&
          before &&
          before !== "ready" &&
          before !== "stopped" &&
          before !== "error"
        ) {
          emitSessionReady(s);
        } else if (s.status === "error" && before !== "error") {
          emitSessionError(s);
        }
      }
    }

    prevStatusRef.current = next;
  }, [sessions]);

  return null;
}

function emitSessionReady(s: Session) {
  addNotification({
    id: `session-ready:${s.id}`,
    type: "session_ready",
    title: `${s.profileName} session is ready`,
    subtitle: s.gpuName ? `${s.gpuName} × ${s.numGpus} · session #${s.id}` : `Session #${s.id}`,
    href: `/sessions/${s.id}`,
    sessionId: s.id,
  });
}

function emitSessionError(s: Session) {
  addNotification({
    id: `session-error:${s.id}`,
    type: "session_error",
    title: `Session #${s.id} encountered an error`,
    subtitle: s.statusMessage ?? s.profileName,
    href: `/sessions/${s.id}`,
    sessionId: s.id,
  });
}

/**
 * Watches repo index status across all known sessions and emits a
 * "Repo indexed" notification when any session transitions to `ready`.
 */
function RepoIndexWatcher() {
  const { data: sessions } = useListSessions();
  const ids = (sessions ?? []).map((s) => s.id);
  const idsParam = ids.length > 0 ? ids.join(",") : undefined;

  const { data: repoStatuses } = useGetBatchRepoStatus(
    { ids: idsParam! },
    {
      query: {
        enabled: !!idsParam,
        refetchInterval: 5000,
        queryKey: getGetBatchRepoStatusQueryKey(idsParam ? { ids: idsParam } : undefined),
      },
    }
  );

  const prevRef = useRef<Map<number, string> | null>(null);

  useEffect(() => {
    const statuses = repoStatuses?.statuses;
    if (!statuses) return;
    const prev = prevRef.current;
    const next = new Map<number, string>();
    for (const [k, v] of Object.entries(statuses)) {
      if (v) next.set(Number(k), v.indexStatus);
    }

    if (prev !== null) {
      for (const [sid, status] of next.entries()) {
        const before = prev.get(sid);
        if (before === status) continue;
        if (status === "ready" && before && before !== "ready" && before !== "none") {
          const sess = sessions?.find((s) => s.id === sid);
          addNotification({
            id: `repo-indexed:${sid}:${Date.now()}`,
            type: "repo_indexed",
            title: `Repo index complete`,
            subtitle: sess ? `Session #${sid} · ${sess.profileName}` : `Session #${sid}`,
            href: `/sessions/${sid}?tab=repo`,
            sessionId: sid,
          });
        }
      }
    }

    prevRef.current = next;
  }, [repoStatuses, sessions]);

  return null;
}

/**
 * Per-session watcher that detects swarm phase transitions, new
 * handoffs, and new conflicts. Mounted once per active session by
 * `PerSessionWatchers`. First-load state is captured without firing
 * notifications; only changes from that baseline produce entries.
 */
function SessionEventWatcher({ sessionId, isReady }: { sessionId: number; isReady: boolean }) {
  // Swarm phase transitions
  const { data: swarmData } = useSwarmStatus(sessionId, isReady);
  const prevSwarmPhaseRef = useRef<string | null>(null);
  const swarmInitializedRef = useRef(false);
  useEffect(() => {
    const phase = swarmData?.snapshot?.phase ?? null;
    if (!swarmInitializedRef.current) {
      // Seed without emitting — avoid retroactive notifications for
      // a swarm whose run completed before the watcher mounted.
      prevSwarmPhaseRef.current = phase;
      if (phase !== null) swarmInitializedRef.current = true;
      return;
    }
    const prev = prevSwarmPhaseRef.current;
    prevSwarmPhaseRef.current = phase;
    if (!phase || phase === prev) return;
    if (
      prev === "synthesising" &&
      phase !== "synthesising" &&
      phase !== "active" &&
      phase !== "aborted"
    ) {
      const done = swarmData?.snapshot?.doneCount ?? 0;
      const total = swarmData?.snapshot?.totalWorkers ?? 0;
      addNotification({
        id: `swarm-completed:${sessionId}:${swarmData?.snapshot?.timestamp ?? Date.now()}`,
        type: "swarm_completed",
        title: "Swarm run finished",
        subtitle: `${done}/${total} workers completed · session #${sessionId}`,
        href: `/sessions/${sessionId}?tab=swarm`,
        sessionId,
      });
    } else if (phase === "aborted" && prev !== "aborted") {
      addNotification({
        id: `swarm-aborted:${sessionId}:${swarmData?.snapshot?.timestamp ?? Date.now()}`,
        type: "swarm_aborted",
        title: "Swarm run aborted",
        subtitle: `Session #${sessionId}`,
        href: `/sessions/${sessionId}?tab=swarm`,
        sessionId,
      });
    }
  }, [swarmData, sessionId]);

  // Handoff arrivals — poll coordination, emit on previously-unseen pending handoffs.
  const { data: coordData } = useGetSessionCoordination(sessionId, {
    query: {
      enabled: !!sessionId,
      refetchInterval: 20000,
      queryKey: getGetSessionCoordinationQueryKey(sessionId),
    },
  });
  const seenHandoffIdsRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const handoffs = coordData?.recentHandoffs ?? [];
    if (seenHandoffIdsRef.current === null) {
      seenHandoffIdsRef.current = new Set(handoffs.map((h) => h.id));
      return;
    }
    const seen = seenHandoffIdsRef.current;
    const typeLabels: Record<string, string> = {
      blocked: "Blocked",
      needs_review: "Needs Review",
      safe_to_merge: "Safe to Merge",
      watch_files: "Watch Files",
      related_lane: "Related Lane",
    };
    // Spec: only persist handoffs when the user is NOT actively viewing
    // the Coordination tab of this session (otherwise the in-page UI
    // already surfaces them). Read route/query directly so we don't add
    // a router-context dependency to a watcher.
    const onCoordinationForThisSession =
      typeof window !== "undefined" &&
      window.location.pathname === `/sessions/${sessionId}` &&
      new URLSearchParams(window.location.search).get("tab") === "coordination";
    for (const h of handoffs) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      if (h.status !== "pending") continue;
      if (onCoordinationForThisSession) continue;
      const label = typeLabels[h.handoffType] ?? h.handoffType;
      addNotification({
        id: `handoff:${sessionId}:${h.id}`,
        type: "handoff",
        title: `Handoff: ${label}`,
        subtitle: h.message ?? `Session #${sessionId}`,
        href: `/sessions/${sessionId}?tab=coordination`,
        sessionId,
      });
    }
  }, [coordData, sessionId]);

  // Conflict detection — poll, emit on previously-unseen lane-pair tuples.
  const { data: conflictsData } = useGetSessionConflicts(sessionId, {
    query: {
      enabled: !!sessionId,
      refetchInterval: 20000,
      queryKey: getGetSessionConflictsQueryKey(sessionId),
    },
  });
  const seenConflictKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!conflictsData) return;
    const active = (conflictsData.conflicts ?? []).filter(
      (c) => c.recommendation !== "no_conflict"
    );
    const keys = active.map((c) => {
      const [a, b] = [c.laneIdA, c.laneIdB].sort((x, y) => x - y);
      return { c, key: `${a}:${b}:${c.recommendation}`, a, b };
    });
    if (seenConflictKeysRef.current === null) {
      seenConflictKeysRef.current = new Set(keys.map((k) => k.key));
      return;
    }
    const seen = seenConflictKeysRef.current;
    for (const { c, key, a, b } of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      addNotification({
        id: `conflict:${sessionId}:${key}`,
        type: "conflict",
        title: c.recommendation === "block" ? "Blocking conflict detected" : "Conflict detected",
        subtitle: `Lanes ${a} ↔ ${b}`,
        href: `/sessions/${sessionId}?tab=coordination`,
        sessionId,
      });
    }
  }, [conflictsData, sessionId]);

  return null;
}

/**
 * Mounts a SessionEventWatcher for every non-terminal session so swarm,
 * handoff, and conflict events surface globally regardless of which
 * page the user is currently viewing.
 */
function PerSessionWatchers() {
  const { data: sessions } = useListSessions();
  const watched = (sessions ?? []).filter((s) => s.status !== "stopped" && s.status !== "error");
  return (
    <>
      {watched.map((s) => (
        <SessionEventWatcher key={s.id} sessionId={s.id} isReady={s.status === "ready"} />
      ))}
    </>
  );
}

/**
 * Combines all global watchers. Mounted once in AppLayout.
 */
/**
 * Polls the safety subsystem's pending-approvals queue and emits a
 * notification for any newly-seen action so it surfaces in the global
 * notification bell, not just on the dedicated /ambient page.
 */
function ApprovalRequestWatcher() {
  const seenIdsRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const baseUrl = import.meta.env.BASE_URL ?? "/";

    const poll = async () => {
      try {
        const r = await fetch(`${baseUrl}api/dashboard/safety/pending`);
        if (!r.ok) return;
        const data = (await r.json()) as { actions: Array<{ id: number; kind: string; summary: string; scope: string }> };
        if (cancelled) return;

        const actions = data.actions ?? [];
        // Seed without firing on first poll so we don't replay old approvals.
        if (seenIdsRef.current === null) {
          seenIdsRef.current = new Set(actions.map((a) => a.id));
          return;
        }
        const seen = seenIdsRef.current;
        for (const a of actions) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          addNotification({
            id: `approval-request:${a.id}`,
            type: "approval_request",
            title: `Approval needed: ${a.kind}`,
            subtitle: a.summary,
            href: `/ambient`,
          });
        }
      } catch {
        // Network blips are fine — try again next tick.
      }
    };

    void poll();
    const t = setInterval(() => { void poll(); }, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return null;
}

export function NotificationWatchers() {
  return (
    <>
      <SessionStatusWatcher />
      <RepoIndexWatcher />
      <PerSessionWatchers />
      <ApprovalRequestWatcher />
    </>
  );
}
