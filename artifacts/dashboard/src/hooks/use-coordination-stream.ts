import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSessionLanesQueryKey,
  getGetSessionConflictsQueryKey,
  getListHeavyJobsQueryKey,
  getGetSessionCoordinationQueryKey,
} from "@workspace/api-client-react";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_BACKOFF_DELAY = 30000;

export type CoordinationStreamStatus = "connected" | "reconnecting" | "polling";

/**
 * Opens an SSE connection to /api/sessions/:id/coordination/stream.
 * When a `coordination_update` event arrives, it invalidates the React Query
 * caches for lanes, conflicts, coordination, and heavy jobs so the Team tab
 * refreshes immediately without waiting for the polling interval.
 *
 * Returns the current connection status so callers can render a live indicator.
 */
export function useCoordinationStream(
  sessionId: number | null | undefined
): CoordinationStreamStatus {
  const queryClient = useQueryClient();
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<CoordinationStreamStatus>("polling");

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    function invalidateAll() {
      queryClient.invalidateQueries({ queryKey: getListSessionLanesQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getGetSessionConflictsQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getGetSessionCoordinationQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getListHeavyJobsQueryKey(sessionId!, { status: "queued,running,deferred" }) });
    }

    function connect() {
      if (cancelled) return;

      const url = `${BASE_URL}api/sessions/${sessionId}/coordination/stream`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (cancelled) { es.close(); return; }
        retryCountRef.current = 0;
        setStatus("connected");
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data) as { type?: string };
          if (msg.type === "coordination_update") {
            invalidateAll();
          }
        } catch {
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        setStatus("reconnecting");

        const delay = RETRY_DELAYS[retryCountRef.current] ?? MAX_BACKOFF_DELAY;
        if (retryCountRef.current < RETRY_DELAYS.length) retryCountRef.current += 1;

        retryTimerRef.current = setTimeout(() => {
          if (!cancelled) connect();
        }, delay);
      };
    }

    connect();

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      invalidateAll();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      retryCountRef.current = 0;
      setStatus("reconnecting");
      connect();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [sessionId, queryClient]);

  return status;
}
