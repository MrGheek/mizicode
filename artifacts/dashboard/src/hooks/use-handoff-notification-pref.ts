import { useState, useCallback } from "react";

export type HandoffNotificationPref = "toast" | "browser" | "none";

const STORAGE_KEY = "handoff-notification-pref";

function readPref(): HandoffNotificationPref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "toast" || stored === "browser" || stored === "none") {
      return stored;
    }
  } catch {
  }
  return "toast";
}

export function useHandoffNotificationPref() {
  const [pref, setPrefState] = useState<HandoffNotificationPref>(readPref);

  const setPref = useCallback(async (next: HandoffNotificationPref): Promise<boolean> => {
    if (next === "browser") {
      if (!("Notification" in window)) {
        return false;
      }
      if (Notification.permission === "denied") {
        return false;
      }
      if (Notification.permission !== "granted") {
        const result = await Notification.requestPermission();
        if (result !== "granted") {
          return false;
        }
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
    }
    setPrefState(next);
    return true;
  }, []);

  const browserPermission: NotificationPermission | "unsupported" =
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported";

  return { pref, setPref, browserPermission };
}
