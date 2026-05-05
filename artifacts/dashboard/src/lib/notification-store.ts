import { useSyncExternalStore } from "react";

export type NotificationType =
  | "session_ready"
  | "session_error"
  | "swarm_completed"
  | "swarm_aborted"
  | "repo_indexed"
  | "handoff"
  | "conflict"
  | "approval_request";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  subtitle?: string;
  href?: string;
  createdAt: number;
  read: boolean;
  sessionId?: number;
}

const STORAGE_KEY = "floatr:notifications:v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 50;

let state: Notification[] = loadFromStorage();
const listeners = new Set<() => void>();

function loadFromStorage(): Notification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Notification[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((n) => n && typeof n.id === "string" && n.createdAt >= cutoff);
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): Notification[] {
  return state;
}

export function addNotification(input: Omit<Notification, "createdAt" | "read"> & { dedupeWindowMs?: number }) {
  const cutoff = Date.now() - MAX_AGE_MS;
  // Dedupe by id within configured window (default: any existing within 24h).
  const dedupeCutoff = input.dedupeWindowMs ? Date.now() - input.dedupeWindowMs : cutoff;
  const exists = state.some((n) => n.id === input.id && n.createdAt >= dedupeCutoff);
  if (exists) return;
  const next: Notification = {
    id: input.id,
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    href: input.href,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    read: false,
  };
  state = [next, ...state.filter((n) => n.createdAt >= cutoff)].slice(0, MAX_ITEMS);
  persist();
  emit();
}

export function markAllRead() {
  if (state.every((n) => n.read)) return;
  state = state.map((n) => ({ ...n, read: true }));
  persist();
  emit();
}

export function clearAll() {
  if (state.length === 0) return;
  state = [];
  persist();
  emit();
}

export function useNotifications(): {
  notifications: Notification[];
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
} {
  const notifications = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const unreadCount = notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
  return { notifications, unreadCount, markAllRead, clearAll };
}
