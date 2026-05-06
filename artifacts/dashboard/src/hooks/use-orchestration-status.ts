import { useEffect, useRef, useState } from "react";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

const POLL_INTERVAL_MS = 4000;

export interface OrchestrationLaneStatus {
  laneId: number;
  memberIdentifier: string;
  role: string;
  laneStatus: string;
  overlayBundleId: number | null;
  ideUrl: string | null;
  bridgeStatus: "connected" | "disconnected";
}

export interface OrchestrationStatusData {
  sessionId: number;
  status: "provisioning" | "ready" | "error" | "stopped";
  bootPhase: string;
  bootMessage: string | null;
  vastInstanceId: number | null;
  allLanesConnected: boolean;
  lanes: OrchestrationLaneStatus[];
  error: string | null;
}

const TERMINAL_STATUSES = new Set(["ready", "error", "stopped"] as const);

/**
 * Polls GET /api/sessions/:id/orchestration-status every POLL_INTERVAL_MS
 * until the endpoint itself returns a terminal status ("ready", "error", or
 * "stopped"), or until the hook unmounts.
 *
 * Importantly:
 * - polling is NOT gated on session.status boot phases — the orchestration
 *   endpoint can remain "provisioning" even after session.status === "ready"
 *   because all lane bridges may not yet be connected.
 * - data is NEVER cleared between polls or when enabled changes; the last
 *   known state is always preserved so the panel doesn't flash away mid-flow.
 * - `enabled` controls whether a new poll cycle starts, but will not discard
 *   data that was already fetched.
 */
export function useOrchestrationStatus(
  sessionId: number | null | undefined,
  enabled: boolean,
) {
  const [data, setData] = useState<OrchestrationStatusData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Track whether we've already reached terminal state so we never restart
  // polling for a session that is fully done, even if `enabled` toggles.
  const terminalRef = useRef(false);
  const prevSessionIdRef = useRef<number | null | undefined>(undefined);

  // Reset terminal guard and data when the sessionId changes.
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    terminalRef.current = false;
    setData(null);
    setFetchError(null);
  }, [sessionId]);

  useEffect(() => {
    // Don't start a new cycle if: disabled, no sessionId, or already terminal.
    if (!enabled || !sessionId || terminalRef.current) return;

    let cancelled = false;
    const abortRef = { current: new AbortController() };
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      if (cancelled || terminalRef.current) return;
      abortRef.current.abort();
      abortRef.current = new AbortController();
      try {
        const res = await fetch(
          `${BASE_URL}api/sessions/${sessionId}/orchestration-status`,
          { signal: abortRef.current.signal },
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          setFetchError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const json = await res.json() as OrchestrationStatusData;
        if (cancelled) return;
        setData(json);
        setFetchError(null);
        if (TERMINAL_STATUSES.has(json.status as "ready" | "error" | "stopped")) {
          terminalRef.current = true;
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setFetchError(err instanceof Error ? err.message : "Polling failed");
      }
    }

    poll();
    intervalId = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      abortRef.current.abort();
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }, [sessionId, enabled]);

  return { data, fetchError };
}
