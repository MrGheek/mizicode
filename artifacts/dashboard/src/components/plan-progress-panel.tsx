import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, Loader2, FileCode2, AlertCircle, ListTodo, Clock,
} from "lucide-react";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

export interface PlanSnapshot {
  activeTask?: string | null;
  planCheckpoint?: string | null;
  activeFiles?: string[];
  unresolvedErrors?: string[];
  taskSummary?: string | null;
  bundleSlug?: string | null;
  updatedAt: string;
}

export interface PlanStatusResponse {
  availability: "live" | "stale" | "starting" | "unavailable";
  snapshot: PlanSnapshot | null;
}

function usePlanStatus(sessionId: number, isActive: boolean): PlanStatusResponse {
  const [state, setState] = useState<PlanStatusResponse>({
    availability: "unavailable",
    snapshot: null,
  });
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const fetchOnce = () => {
      fetch(`${BASE_URL}api/sessions/${sessionId}/plan-status`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: PlanStatusResponse | null) => { if (data && !cancelled) setState(data); })
        .catch(() => {});
    };

    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (cancelled) return;
        fetchOnce();
      }, 8000);
    };

    // Always do an initial fetch to show any persisted snapshot
    fetchOnce();

    // Only subscribe to SSE for live updates when session is active
    if (isActive) {
      const url = `${BASE_URL}api/sessions/${sessionId}/plan-stream`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data) as PlanStatusResponse;
          setState(data);
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        startPolling();
      };
    }

    return () => {
      cancelled = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sessionId, isActive]);

  return state;
}

export function usePlanProgressStatus(sessionId: number, isActive: boolean) {
  return usePlanStatus(sessionId, isActive);
}

function CheckpointLines({ text }: { text: string }) {
  const lines = text
    .split(/\n|;/)
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) return <p className="text-xs text-muted-foreground">{text}</p>;

  return (
    <ul className="space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="w-3 h-3 text-emerald-500/60 shrink-0 mt-0.5" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

interface PlanProgressPanelProps {
  sessionId: number;
  isActive: boolean;
}

export function PlanProgressPanel({ sessionId, isActive }: PlanProgressPanelProps) {
  const { availability, snapshot } = usePlanStatus(sessionId, isActive);

  if (availability === "unavailable" || availability === "starting") return null;
  if (!snapshot) return null;

  const hasActiveTask = !!snapshot.activeTask;
  const hasCheckpoint = !!snapshot.planCheckpoint;
  const hasFiles = snapshot.activeFiles && snapshot.activeFiles.length > 0;
  const hasErrors = snapshot.unresolvedErrors && snapshot.unresolvedErrors.length > 0;

  if (!hasActiveTask && !hasCheckpoint && !hasFiles && !hasErrors) return null;

  const isLive = availability === "live";
  const updatedAgo = (() => {
    try {
      const ms = Date.now() - new Date(snapshot.updatedAt).getTime();
      if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
      if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
      return `${Math.round(ms / 3600000)}h ago`;
    } catch {
      return null;
    }
  })();

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          MIZI Progress
          {isLive ? (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              Live
            </Badge>
          ) : updatedAgo ? (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <Clock className="w-2.5 h-2.5" />
              {updatedAgo}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {hasActiveTask && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Active Task
            </p>
            <div className="flex items-start gap-2">
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0 mt-0.5" />
              <p className="text-sm font-medium leading-snug">{snapshot.activeTask}</p>
            </div>
            {snapshot.taskSummary && snapshot.taskSummary !== snapshot.activeTask && (
              <p className="text-xs text-muted-foreground pl-5 leading-snug">
                {snapshot.taskSummary}
              </p>
            )}
          </div>
        )}

        {hasCheckpoint && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Plan Checkpoint
            </p>
            <CheckpointLines text={snapshot.planCheckpoint!} />
          </div>
        )}

        {hasFiles && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Active Files
            </p>
            <ul className="space-y-0.5">
              {snapshot.activeFiles!.slice(0, 5).map((f, i) => (
                <li key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                  <FileCode2 className="w-3 h-3 text-primary/50 shrink-0" />
                  <span className="truncate">{f}</span>
                </li>
              ))}
              {snapshot.activeFiles!.length > 5 && (
                <li className="text-xs text-muted-foreground/60 pl-4">
                  +{snapshot.activeFiles!.length - 5} more
                </li>
              )}
            </ul>
          </div>
        )}

        {hasErrors && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Unresolved Errors
            </p>
            <ul className="space-y-1">
              {snapshot.unresolvedErrors!.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-red-400/80">
                  <AlertCircle className="w-3 h-3 text-red-400/70 shrink-0 mt-0.5" />
                  <span className="leading-snug">{e}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
