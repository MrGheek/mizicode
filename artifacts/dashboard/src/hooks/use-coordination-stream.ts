import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSessionLanesQueryKey,
  getGetSessionConflictsQueryKey,
  getListHeavyJobsQueryKey,
  getGetSessionCoordinationQueryKey,
} from "@workspace/api-client-react";
import { useVisibilityReconnect } from "./use-visibility-reconnect";

import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_BACKOFF_DELAY = 30000;

const HEARTBEAT_TIMEOUT_MS = 45_000;

export type CoordinationStreamStatus = "connected" | "reconnecting" | "polling";

/**
 * Opens an SSE connection to /api/sessions/:id/coordination/stream.
 * When a `coordination_update` event arrives, it invalidates the React Query
 * caches for lanes, conflicts, coordination, and heavy jobs so the Team tab
 * refreshes immediately without waiting for the polling interval.
 *
 * Also handles the Page Lifecycle `resume` event and a heartbeat timeout so
 * that a stale connection is detected and re-established after a device
 * sleep/wake cycle (which may not trigger `visibilitychange`).
 *
 * Returns the current connection status so callers can render a live indicator.
 */
export function useCoordinationStream(
  sessionId: number | null | undefined
): CoordinationStreamStatus {
  const queryClient = useQueryClient();
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<CoordinationStreamStatus>("polling");

  // Stored by the main effect so useVisibilityReconnect can trigger a reconnect
  // without closing over stale captured variables.
  const visibilityReconnectRef = useRef<(() => void) | null>(null);

  useVisibilityReconnect(() => {
    visibilityReconnectRef.current?.();
  });

  useEffect(() => {
    if (!sessionId) {
      visibilityReconnectRef.current = null;
      return;
    }

    let cancelled = false;

    function invalidateAll() {
      queryClient.invalidateQueries({ queryKey: getListSessionLanesQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getGetSessionConflictsQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getGetSessionCoordinationQueryKey(sessionId!) });
      queryClient.invalidateQueries({ queryKey: getListHeavyJobsQueryKey(sessionId!, { status: "queued,running,deferred" }) });
    }

    function clearHeartbeat() {
      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    function resetHeartbeat() {
      clearHeartbeat();
      heartbeatTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        retryCountRef.current = 0;
        setStatus("reconnecting");
        connect();
      }, HEARTBEAT_TIMEOUT_MS);
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
        resetHeartbeat();
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        resetHeartbeat();
        try {
          const msg = JSON.parse(event.data) as { type?: string };
          if (msg.type === "coordination_update") {
            invalidateAll();
          }
        } catch {
        }
      };

      es.addEventListener("ping", () => {
        if (cancelled) return;
        resetHeartbeat();
      });

      es.onerror = () => {
        if (cancelled) return;
        clearHeartbeat();
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

    // Shared reconnect logic: invalidate caches, tear down stale connection, reconnect.
    // Used by both useVisibilityReconnect (visibilitychange) and the resume listener below.
    function reconnectImmediately() {
      if (cancelled) return;
      invalidateAll();
      clearHeartbeat();
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

    function handleResume() {
      reconnectImmediately();
    }

    connect();

    // Expose for the shared useVisibilityReconnect hook (handles visibilitychange).
    visibilityReconnectRef.current = reconnectImmediately;
    // Also handle the Page Lifecycle `resume` event for device sleep/wake cycles,
    // which may not fire visibilitychange.
    document.addEventListener("resume", handleResume);

    return () => {
      cancelled = true;
      visibilityReconnectRef.current = null;
      document.removeEventListener("resume", handleResume);
      clearHeartbeat();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [sessionId, queryClient]);

  return status;
}
