/**
 * use-factory-stream.ts — RFC 0005: SSE hook over RFC 0006's
 * GET /factory/products/:id/stream. Mirrors use-coordination-stream.ts.
 *
 * On each `factory_event` it invalidates the `["factory", ...]` query keys so
 * the board, signals, and trends reconcile from fresh data. Polling is only
 * the reconnect fallback, never the steady state.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVisibilityReconnect } from "./use-visibility-reconnect";
import { API_BASE_URL } from "@/lib/api-url";
import { factoryKeys } from "./use-factory";
import type { FactoryEventMessage } from "@/lib/factory-types";

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_BACKOFF_DELAY = 30000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export type FactoryStreamStatus = "connected" | "reconnecting" | "polling";

export function useFactoryStream(
  productId: number | null | undefined,
): FactoryStreamStatus {
  const queryClient = useQueryClient();
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<FactoryStreamStatus>("polling");
  const visibilityReconnectRef = useRef<(() => void) | null>(null);

  useVisibilityReconnect(() => {
    visibilityReconnectRef.current?.();
  });

  useEffect(() => {
    if (productId == null || !Number.isFinite(productId)) {
      visibilityReconnectRef.current = null;
      return;
    }

    let cancelled = false;

    function invalidateAll() {
      queryClient.invalidateQueries({ queryKey: factoryKeys.all });
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

      const url = `${API_BASE_URL}api/factory/products/${productId}/stream`;
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
          const msg = JSON.parse(event.data) as FactoryEventMessage;
          if (msg.type === "factory_event") {
            invalidateAll();
          }
        } catch {
          /* ignore malformed frames */
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

    visibilityReconnectRef.current = reconnectImmediately;
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
  }, [productId, queryClient]);

  return status;
}
