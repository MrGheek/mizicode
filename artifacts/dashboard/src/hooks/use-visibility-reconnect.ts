import { useEffect, useRef } from "react";

/**
 * Calls `onVisible` whenever the browser tab regains focus
 * (document.visibilityState transitions to "visible").
 *
 * Use this to reconnect SSE or WebSocket feeds that may have stalled
 * while the tab was backgrounded.
 *
 * The latest `onVisible` reference is captured via a ref so callers
 * do not need to stabilise it with useCallback — the listener is
 * registered only once per mount.
 */
export function useVisibilityReconnect(onVisible: () => void): void {
  const onVisibleRef = useRef(onVisible);
  useEffect(() => {
    onVisibleRef.current = onVisible;
  });

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        onVisibleRef.current();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);
}
