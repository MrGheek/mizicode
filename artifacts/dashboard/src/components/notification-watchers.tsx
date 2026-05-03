import { useEffect, useRef } from "react";
import {
  useListSessions,
  useGetBatchRepoStatus,
  getGetBatchRepoStatusQueryKey,
  getListSessionsQueryKey,
} from "@workspace/api-client-react";
import type { Session } from "@workspace/api-client-react";
import { addNotification } from "@/lib/notification-store";

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
  const { data: sessions } = useListSessions({ query: { refetchInterval: 10000, queryKey: getListSessionsQueryKey() } });
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
        if (s.status === "ready" && before && before !== "ready" && before !== "stopped" && before !== "error") {
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
export function RepoIndexWatcher() {
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
 * Combines all global watchers. Mounted once in AppLayout.
 */
export function NotificationWatchers() {
  return (
    <>
      <SessionStatusWatcher />
      <RepoIndexWatcher />
    </>
  );
}
