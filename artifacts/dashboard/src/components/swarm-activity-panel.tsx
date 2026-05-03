import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Network, ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Loader2,
  AlertTriangle, GitMerge, SkipForward, Minus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useVisibilityReconnect } from "@/hooks/use-visibility-reconnect";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export interface SwarmWorker {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "aborted";
  priority?: number;
  outputPreview?: string;
  outputFull?: string;
  errorSummary?: string;
  retryCount?: number;
}

export interface SwarmSnapshot {
  phase: "active" | "idle" | "synthesising" | "aborted" | "sequential" | "never";
  skipReason?: string;
  orchestratorReason?: string;
  decompositionReason?: string;
  totalWorkers?: number;
  workers?: SwarmWorker[];
  doneCount?: number;
  failedCount?: number;
  synthesisResult?: string;
  timestamp: string;
  isHistorical?: boolean;
}

export interface SwarmStatusResponse {
  availability: "live" | "stale" | "starting" | "unavailable";
  snapshot: SwarmSnapshot | null;
}

function workerStatusIcon(status: SwarmWorker["status"]) {
  switch (status) {
    case "done":    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case "failed":  return <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />;
    case "running": return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />;
    case "aborted": return <Minus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
    default:        return <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
  }
}

function workerStatusLabel(status: SwarmWorker["status"]) {
  const map: Record<SwarmWorker["status"], string> = {
    pending: "Pending",
    running: "Running",
    done: "Done",
    failed: "Failed",
    aborted: "Aborted",
  };
  return map[status] ?? status;
}

function SwarmProgressBar({ done, failed, total }: { done: number; failed: number; total: number }) {
  const pctDone = total > 0 ? (done / total) * 100 : 0;
  const pctFailed = total > 0 ? (failed / total) * 100 : 0;
  return (
    <div className="w-full h-2 rounded-full bg-secondary/40 overflow-hidden flex">
      <div
        className="h-full bg-emerald-500 transition-all duration-500"
        style={{ width: `${pctDone}%` }}
      />
      <div
        className="h-full bg-red-500 transition-all duration-500"
        style={{ width: `${pctFailed}%` }}
      />
    </div>
  );
}

function WorkerRow({ worker }: { worker: SwarmWorker }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`border rounded text-xs transition-colors ${worker.status === "failed" ? "border-red-500/40 bg-red-500/5" : "border-border/40"}`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/20 transition-colors"
      >
        {workerStatusIcon(worker.status)}
        <span className="flex-1 font-medium truncate">{worker.title}</span>
        {worker.priority !== undefined && (
          <span className="text-[10px] text-muted-foreground shrink-0">P{worker.priority}</span>
        )}
        {worker.retryCount !== undefined && worker.retryCount > 0 && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 text-yellow-500 border-yellow-500/40">
            ×{worker.retryCount} retry
          </Badge>
        )}
        <Badge
          variant="outline"
          className={`text-[9px] px-1.5 py-0 shrink-0 ${
            worker.status === "done" ? "text-emerald-500 border-emerald-500/40" :
            worker.status === "failed" ? "text-red-500 border-red-500/40" :
            worker.status === "running" ? "text-primary border-primary/40" :
            "text-muted-foreground"
          }`}
        >
          {workerStatusLabel(worker.status)}
        </Badge>
        {expanded ? <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />}
      </button>

      {worker.outputPreview && !expanded && (
        <p className="px-3 pb-2 text-[10px] text-muted-foreground truncate font-mono">
          {worker.outputPreview}
        </p>
      )}

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/30 pt-2">
          {worker.errorSummary && (
            <div className="flex items-start gap-2 text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="text-[10px] leading-relaxed">{worker.errorSummary}</span>
            </div>
          )}
          {(worker.outputFull || worker.outputPreview) && (
            <pre className="text-[10px] font-mono text-muted-foreground bg-secondary/20 rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {worker.outputFull ?? worker.outputPreview}
            </pre>
          )}
          {!worker.errorSummary && !worker.outputFull && !worker.outputPreview && (
            <p className="text-[10px] text-muted-foreground italic">No output yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function buildTabBadgeLabel(snapshot: SwarmSnapshot | null, availability: SwarmStatusResponse["availability"]): string | null {
  if (!snapshot) return null;
  const { phase, doneCount = 0, failedCount = 0, totalWorkers = 0 } = snapshot;
  if (availability === "starting") return null;
  if (phase === "active") {
    if (failedCount > 0) return `${doneCount} done · ${failedCount} failed`;
    return `${doneCount} / ${totalWorkers}`;
  }
  if (phase === "synthesising") return "Synthesising…";
  if (phase === "aborted") return "Aborted";
  return null;
}

export function useSwarmStatus(sessionId: number, isReady: boolean) {
  const [data, setData] = useState<SwarmStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Incrementing this forces the SSE effect to tear down and reconnect.
  const [reconnectKey, setReconnectKey] = useState(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/swarm-status`);
      if (!res.ok) throw new Error("Failed");
      const json: SwarmStatusResponse = await res.json();
      setData(json);
    } catch {
      // Keep stale data on error
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Reconnect the SSE stream whenever the tab regains focus to avoid silent stalls.
  useVisibilityReconnect(() => {
    if (isReady) setReconnectKey((k) => k + 1);
    else fetchStatus();
  });

  useEffect(() => {
    if (!sessionId) return;

    if (!isReady) {
      // Session not yet ready — fetch once for historical snapshot then stop.
      fetchStatus();
      return;
    }

    // Session is ready — open an SSE stream for instant push updates.
    // Fall back to 3-second polling if the connection cannot be established.
    let es: EventSource | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    const startPollingFallback = () => {
      if (fallbackInterval) return;
      fetchStatus();
      fallbackInterval = setInterval(fetchStatus, 3000);
    };

    try {
      es = new EventSource(`${BASE_URL}api/sessions/${sessionId}/swarm-stream`);

      es.onmessage = (event) => {
        try {
          const json: SwarmStatusResponse = JSON.parse(event.data);
          setData(json);
          setLoading(false);
        } catch {
          // Ignore malformed SSE events
        }
      };

      es.onerror = () => {
        es?.close();
        es = null;
        // Connection failed — degrade gracefully to polling
        startPollingFallback();
      };
    } catch {
      // EventSource constructor failed (very unusual) — fall back immediately
      startPollingFallback();
    }

    return () => {
      es?.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [sessionId, isReady, fetchStatus, reconnectKey]);

  return { data, loading };
}

export function swarmTabBadgeLabel(data: SwarmStatusResponse | null): string | null {
  if (!data) return null;
  return buildTabBadgeLabel(data.snapshot, data.availability);
}

export function swarmTabIsActive(data: SwarmStatusResponse | null): boolean {
  // Only pulse the tab indicator when workers are actively running (phase === "active").
  // Synthesising is a terminal completion step, not an ongoing parallel-work phase.
  return data?.snapshot?.phase === "active";
}

export function swarmTabShouldShow(data: SwarmStatusResponse | null): boolean {
  if (!data) return false;
  if (data.availability === "unavailable" && !data.snapshot) return false;
  const phase = data.snapshot?.phase;
  return phase !== "never" && phase !== undefined;
}

function SwarmPillUI({ sessionId, data }: { sessionId: number; data: SwarmStatusResponse | null }) {
  const [, setLocation] = useLocation();
  const label = swarmTabBadgeLabel(data);
  const phase = data?.snapshot?.phase;
  const visible = label !== null && (phase === "active" || phase === "synthesising");

  if (!visible) return null;

  const isLive = phase === "active";

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setLocation(`/sessions/${sessionId}?tab=swarm`);
      }}
      title="View Swarm activity"
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors
        ${isLive
          ? "bg-primary/10 border-primary/30 text-primary hover:bg-primary/20"
          : "bg-secondary/60 border-border/50 text-muted-foreground hover:bg-secondary"
        }`}
    >
      {isLive ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
        </span>
      ) : (
        <Network className="w-3 h-3" />
      )}
      {label}
    </button>
  );
}

function SwarmPillWithOwnFetch({ sessionId, isReady }: { sessionId: number; isReady: boolean }) {
  const { data } = useSwarmStatus(sessionId, isReady);
  return <SwarmPillUI sessionId={sessionId} data={data} />;
}

export function SwarmPill({
  sessionId,
  isReady,
  data,
}: {
  sessionId: number;
  isReady: boolean;
  data?: SwarmStatusResponse | null;
}) {
  if (data !== undefined) {
    return <SwarmPillUI sessionId={sessionId} data={data} />;
  }
  return <SwarmPillWithOwnFetch sessionId={sessionId} isReady={isReady} />;
}

interface SwarmActivityPanelProps {
  sessionId: number;
  isReady: boolean;
  isSessionOwner: boolean;
  /** Owner token from the session detail endpoint. Sent as Bearer auth on the abort request. */
  ownerToken?: string | null;
}

export function SwarmActivityPanel({ sessionId, isReady, isSessionOwner, ownerToken }: SwarmActivityPanelProps) {
  const { data, loading } = useSwarmStatus(sessionId, isReady);
  const [abortDialogOpen, setAbortDialogOpen] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const { toast } = useToast();

  const handleAbort = async () => {
    setIsAborting(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (ownerToken) headers["Authorization"] = `Bearer ${ownerToken}`;
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/swarm/abort`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error("Abort failed");
      toast({ title: "Abort signal sent", description: "The orchestrator will stop accepting new workers." });
    } catch {
      toast({ title: "Abort failed", variant: "destructive" });
    } finally {
      setIsAborting(false);
      setAbortDialogOpen(false);
    }
  };

  if (loading) {
    return (
      <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading swarm status…
      </div>
    );
  }

  const availability = data?.availability ?? "unavailable";
  const snapshot = data?.snapshot ?? null;

  // State 1: Never swarmed
  if (availability === "unavailable" || !snapshot || snapshot.phase === "never") {
    return (
      <div className="mt-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Network className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p>The model hasn't parallelised anything in this session.</p>
            <p className="text-xs mt-1 opacity-60">Swarm activity will appear here when the orchestrator decomposes a task into parallel workers.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // State 2: Session is still starting
  if (availability === "starting") {
    return (
      <div className="mt-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-30" />
            <p className="text-sm">Session is still starting up.</p>
            <p className="text-xs mt-1 opacity-60">Swarm status will be available once the session is ready.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // State 3: Model chose sequential execution
  if (snapshot.phase === "sequential") {
    return (
      <div className="mt-4 space-y-3">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            <SkipForward className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">The model evaluated this task and chose sequential execution.</p>
            {snapshot.skipReason && (
              <p className="text-xs mt-2 max-w-sm mx-auto text-muted-foreground/80 leading-relaxed">
                "{snapshot.skipReason}"
              </p>
            )}
            <p className="text-[10px] mt-3 text-muted-foreground/50">
              Recorded {new Date(snapshot.timestamp).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const workers = snapshot.workers ?? [];
  const doneCount = snapshot.doneCount ?? workers.filter(w => w.status === "done").length;
  const failedCount = snapshot.failedCount ?? workers.filter(w => w.status === "failed").length;
  const totalWorkers = snapshot.totalWorkers ?? workers.length;
  const isActive = snapshot.phase === "active";
  const isSynthesising = snapshot.phase === "synthesising";
  const isAborted = snapshot.phase === "aborted";
  const isHistorical = snapshot.isHistorical || (!isActive && !isSynthesising);

  return (
    <div className="mt-4 space-y-3">
      {/* Historical label */}
      {isHistorical && !isAborted && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary/30 border border-border/40 rounded px-3 py-2">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Showing the last completed swarm run — no swarm is active right now.</span>
        </div>
      )}

      {/* Stale warning */}
      {availability === "stale" && (
        <div className="flex items-center gap-2 text-xs text-yellow-500 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Runner is temporarily unreachable — showing last known state.</span>
        </div>
      )}

      {/* Orchestrator intent */}
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
            <Network className="w-4 h-4" />
            Orchestrator Intent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.orchestratorReason && (
            <div>
              <p className="text-xs text-muted-foreground/60 uppercase tracking-wide mb-0.5">Why parallelise</p>
              <p className="text-sm text-foreground/90 leading-relaxed">{snapshot.orchestratorReason}</p>
            </div>
          )}
          {snapshot.decompositionReason && (
            <div>
              <p className="text-xs text-muted-foreground/60 uppercase tracking-wide mb-0.5">Decomposition strategy</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{snapshot.decompositionReason}</p>
            </div>
          )}
          <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
            <span>{totalWorkers} worker{totalWorkers !== 1 ? "s" : ""} decided</span>
            {snapshot.timestamp && (
              <span className="text-muted-foreground/50">
                {new Date(snapshot.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Progress bar + synthesis overlay / worker list */}
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              {isSynthesising ? <GitMerge className="w-4 h-4 text-primary" /> : <Network className="w-4 h-4" />}
              {isSynthesising ? "Synthesis" : isAborted ? "Aborted Run" : "Workers"}
            </CardTitle>
            <div className="flex items-center gap-2">
              {isActive && (
                <Badge className="text-[10px] px-1.5 py-0 bg-primary/20 text-primary border-primary/30 animate-pulse">
                  Live
                </Badge>
              )}
              {isSessionOwner && (isActive || isSynthesising) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-red-500/40 text-red-400 hover:bg-red-500/10"
                  onClick={() => setAbortDialogOpen(true)}
                >
                  Abort (emergency)
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Progress bar */}
          {totalWorkers > 0 && (
            <div className="space-y-1">
              <SwarmProgressBar done={doneCount} failed={failedCount} total={totalWorkers} />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{doneCount} done{failedCount > 0 ? ` · ${failedCount} failed` : ""}</span>
                <span>{totalWorkers - doneCount - failedCount} remaining</span>
              </div>
            </div>
          )}

          {/* Synthesis overlay */}
          {isSynthesising && (
            <div className="py-6 text-center">
              <div className="flex items-center justify-center gap-2 text-primary mb-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm font-medium">The model is synthesising results…</span>
              </div>
              <p className="text-xs text-muted-foreground">Combining worker outputs into a unified response.</p>
            </div>
          )}

          {/* Synthesis result (idle after synthesis) */}
          {!isSynthesising && snapshot.synthesisResult && (
            <div className="bg-primary/5 border border-primary/20 rounded p-3">
              <p className="text-xs text-muted-foreground/60 uppercase tracking-wide mb-1">Synthesis result</p>
              <p className="text-sm text-foreground/90 leading-relaxed">{snapshot.synthesisResult}</p>
            </div>
          )}

          {/* Aborted banner */}
          {isAborted && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary/30 border border-border/40 rounded px-3 py-2">
              <Minus className="w-4 h-4 shrink-0" />
              <span>This swarm run was aborted before completion.</span>
            </div>
          )}

          {/* Worker list (hidden during synthesis) */}
          {!isSynthesising && workers.length > 0 && (
            <div className="space-y-1.5">
              {workers.map(worker => (
                <WorkerRow key={worker.id} worker={worker} />
              ))}
            </div>
          )}

          {!isSynthesising && workers.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No worker details available.</p>
          )}
        </CardContent>
      </Card>

      {/* Abort confirmation dialog */}
      <Dialog open={abortDialogOpen} onOpenChange={setAbortDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="w-5 h-5" />
              Confirm Emergency Abort
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>This will signal the orchestrator to stop accepting new workers and abort the current swarm run.</p>
            <p className="text-yellow-500/80">Workers that are already running will complete their current step before stopping. This cannot be undone.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAbortDialogOpen(false)} disabled={isAborting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleAbort}
              disabled={isAborting}
            >
              {isAborting ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Aborting…</> : "Abort swarm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
