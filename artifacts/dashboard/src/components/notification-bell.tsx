import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Bell, CheckCircle2, XCircle, Network, Database, Users, AlertTriangle, GitMerge } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useNotifications, type Notification, type NotificationType } from "@/lib/notification-store";
import { formatDistanceToNow } from "date-fns";

function iconFor(type: NotificationType) {
  switch (type) {
    case "session_ready": return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
    case "session_error": return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
    case "swarm_completed": return <Network className="w-4 h-4 text-primary shrink-0" />;
    case "swarm_aborted": return <Network className="w-4 h-4 text-yellow-500 shrink-0" />;
    case "repo_indexed": return <Database className="w-4 h-4 text-emerald-500 shrink-0" />;
    case "handoff": return <Users className="w-4 h-4 text-primary shrink-0" />;
    case "conflict": return <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />;
    default: return <GitMerge className="w-4 h-4 text-muted-foreground shrink-0" />;
  }
}

function NotificationItem({ n, onNavigate }: { n: Notification; onNavigate: (href: string) => void }) {
  const ago = formatDistanceToNow(new Date(n.createdAt), { addSuffix: true });
  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-2.5 rounded transition-colors ${
        n.read ? "bg-transparent" : "bg-primary/5"
      }`}
      data-testid={`notification-item-${n.type}`}
    >
      {iconFor(n.type)}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground leading-snug">{n.title}</p>
        {n.subtitle && (
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug truncate">{n.subtitle}</p>
        )}
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-[10px] text-muted-foreground/70 font-mono">{ago}</span>
          {n.href && (
            <button
              onClick={() => onNavigate(n.href!)}
              className="text-[10px] text-primary hover:underline font-medium"
              data-testid={`notification-view-${n.id}`}
            >
              View →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, markAllRead, clearAll } = useNotifications();
  const [pulse, setPulse] = useState(false);
  const lastUnreadRef = useRef(unreadCount);

  // Pulse the bell when a new unread notification arrives, and keep the
  // ref synced when the count drops (e.g. mark-all-read).
  useEffect(() => {
    if (unreadCount > lastUnreadRef.current) {
      setPulse(true);
      lastUnreadRef.current = unreadCount;
      const t = setTimeout(() => setPulse(false), 1500);
      return () => clearTimeout(t);
    }
    lastUnreadRef.current = unreadCount;
    return undefined;
  }, [unreadCount]);

  const handleNavigate = (href: string) => {
    setOpen(false);
    setLocation(href);
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o && unreadCount > 0) markAllRead(); }}>
      <PopoverTrigger asChild>
        <button
          className="relative inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-secondary/60 transition-colors text-muted-foreground hover:text-foreground"
          aria-label={`Notifications (${unreadCount} unread)`}
          data-testid="button-notification-bell"
        >
          <Bell className={`w-4 h-4 ${pulse ? "animate-bell-shake" : ""}`} />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold leading-none"
              data-testid="notification-badge-count"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="notification-popover">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60">
          <h3 className="text-sm font-semibold">Notifications</h3>
          <div className="flex items-center gap-1">
            {notifications.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={markAllRead}
                  data-testid="button-mark-all-read"
                >
                  Mark all read
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={clearAll}
                  data-testid="button-clear-notifications"
                >
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="max-h-[400px] overflow-y-auto py-1 px-1">
          {notifications.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Bell className="w-6 h-6 mx-auto mb-2 opacity-30" />
              <p className="text-xs">No notifications yet.</p>
              <p className="text-[10px] opacity-70 mt-1">Async events will appear here.</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {notifications.map((n) => (
                <NotificationItem key={n.id} n={n} onNavigate={handleNavigate} />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
