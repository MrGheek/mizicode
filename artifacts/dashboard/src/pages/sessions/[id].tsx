import { useLocation, useParams } from "wouter";
import {
  useGetSession,
  useDeleteSession,
  useRefreshSessionStatus,
  getGetSessionQueryKey
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Terminal, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, ExternalLink, ArrowLeft, Brain, ChevronDown, ChevronRight, Radio
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useRef } from "react";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

interface MemSession {
  id: string;
  userId: string;
  projectPath: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  observationCount: number;
}

interface MemObservation {
  id: number;
  sessionId: string;
  userId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  recordedAt: number;
}

function useMemSessions(sessionId: number) {
  return useQuery<MemSession[]>({
    queryKey: ["mem-sessions", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const url = `${BASE_URL}api/sessions/${sessionId}/memory/sessions`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch memory sessions");
      return res.json();
    },
    refetchInterval: 30000,
  });
}

function useMemObservations(sessionId: number, isActive: boolean) {
  return useQuery<MemObservation[]>({
    queryKey: ["mem-observations", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const url = `${BASE_URL}api/sessions/${sessionId}/memory/observations`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch memory observations");
      return res.json();
    },
    refetchInterval: isActive ? false : 30000,
  });
}

const RETRY_DELAYS = [3000, 10000, 30000];
const MAX_RETRIES = RETRY_DELAYS.length;

function MemoryTab({
  sessionId,
  isActive,
  onNewObservation,
}: {
  sessionId: number;
  isActive: boolean;
  onNewObservation?: () => void;
}) {
  const { data: sessions, isLoading: sessionsLoading } = useMemSessions(sessionId);
  const { data: polledObservations, isLoading: obsLoading } = useMemObservations(sessionId, isActive);
  const [streamedObservations, setStreamedObservations] = useState<MemObservation[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const onNewObservationRef = useRef(onNewObservation);
  onNewObservationRef.current = onNewObservation;
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStreamedObservations([]);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    function connect() {
      if (cancelled) return;

      const url = `${BASE_URL}api/sessions/${sessionId}/memory/stream`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (cancelled) { es.close(); return; }
        retryCountRef.current = 0;
        setStreaming(true);
        setReconnecting(false);
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const obs: MemObservation = JSON.parse(event.data);
          setStreamedObservations(prev => {
            if (prev.some(o => o.id === obs.id)) return prev;
            onNewObservationRef.current?.();
            return [obs, ...prev];
          });
        } catch {
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        setStreaming(false);

        if (retryCountRef.current >= MAX_RETRIES) {
          setReconnecting(false);
          return;
        }

        const delay = RETRY_DELAYS[retryCountRef.current];
        retryCountRef.current += 1;
        setReconnecting(true);

        retryTimerRef.current = setTimeout(() => {
          if (!cancelled) connect();
        }, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setStreaming(false);
      setReconnecting(false);
      retryCountRef.current = 0;
    };
  }, [sessionId]);

  const observations = (() => {
    if (!isActive) return polledObservations || [];
    const seen = new Set<number>();
    const merged: MemObservation[] = [];
    for (const obs of [...streamedObservations, ...(polledObservations || [])]) {
      if (!seen.has(obs.id)) {
        seen.add(obs.id);
        merged.push(obs);
      }
    }
    return merged.sort((a, b) => b.recordedAt - a.recordedAt);
  })();

  const toggleSession = (id: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (sessionsLoading || obsLoading) {
    return (
      <div className="space-y-3 mt-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const hasSessions = sessions && sessions.length > 0;
  const hasObservations = observations && observations.length > 0;

  if (!hasSessions && !hasObservations) {
    return (
      <Card className="mt-4 bg-card/50 border-border/50">
        <CardContent className="pt-6 pb-6 text-center text-muted-foreground text-sm">
          <Brain className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p>No session memory recorded yet.</p>
          <p className="text-xs mt-1 opacity-70">Memory is captured automatically as the AI uses tools during a session.</p>
        </CardContent>
      </Card>
    );
  }

  const obsBySession = (observations || []).reduce<Record<string, MemObservation[]>>((acc, obs) => {
    if (!acc[obs.sessionId]) acc[obs.sessionId] = [];
    acc[obs.sessionId].push(obs);
    return acc;
  }, {});

  return (
    <div className="mt-4 space-y-3">
      {/* Recent Tool Observations */}
      {hasObservations && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Brain className="w-4 h-4" /> Recent Tool Observations
              {streaming && (
                <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-emerald-500 normal-case tracking-normal">
                  <Radio className="w-3 h-3 animate-pulse" /> Live
                </span>
              )}
              {!streaming && reconnecting && (
                <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-amber-500 normal-case tracking-normal">
                  <Radio className="w-3 h-3 animate-pulse" /> Reconnecting…
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(observations || []).slice(0, 20).map(obs => (
              <div key={obs.id} className="border border-border/40 rounded p-2 text-xs font-mono">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-primary font-semibold">{obs.toolName}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {format(new Date(obs.recordedAt * 1000), "MMM d HH:mm")}
                  </span>
                </div>
                {obs.inputSummary && (
                  <p className="text-muted-foreground truncate" title={obs.inputSummary}>
                    In: {obs.inputSummary}
                  </p>
                )}
                {obs.outputSummary && (
                  <p className="text-muted-foreground truncate" title={obs.outputSummary}>
                    Out: {obs.outputSummary}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Past Session Summaries */}
      {hasSessions && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Clock className="w-4 h-4" /> Session History
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(sessions || []).map(sess => {
              const isExpanded = expandedSessions.has(sess.id);
              const sessObs = obsBySession[sess.id] || [];
              return (
                <div key={sess.id} className="border border-border/40 rounded">
                  <button
                    onClick={() => toggleSession(sess.id)}
                    className="w-full flex items-center justify-between p-2 text-left hover:bg-secondary/20 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="font-mono text-[10px] text-primary/60 flex-shrink-0 bg-primary/10 rounded px-1">
                        {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
                        {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                      </span>
                      {sess.summary && (
                        <span className="text-xs truncate text-foreground/80">{sess.summary}</span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-2">
                      {sess.observationCount} obs
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-1">
                      {sess.summary && (
                        <p className="text-xs text-muted-foreground mb-2 pt-1 border-t border-border/40">
                          {sess.summary}
                        </p>
                      )}
                      {sessObs.length > 0 ? (
                        sessObs.map(obs => (
                          <div key={obs.id} className="font-mono text-[10px] text-muted-foreground bg-secondary/20 rounded px-2 py-1">
                            <span className="text-primary">{obs.toolName}</span>
                            {obs.inputSummary && <span className="ml-2 truncate">({obs.inputSummary})</span>}
                          </div>
                        ))
                      ) : (
                        <p className="text-[10px] text-muted-foreground italic">No observations loaded for this session</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams();
  const sessionId = id ? parseInt(id, 10) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"overview" | "memory">("overview");
  const [newObsCount, setNewObsCount] = useState(0);

  const { data: session, isLoading } = useGetSession(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionQueryKey(sessionId),
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "ready" || s === "stopped" || s === "error" ? false : 5000;
      },
    }
  });

  const deleteSession = useDeleteSession();
  const refreshStatus = useRefreshSessionStatus();

  const handleStop = () => {
    if (!confirm("Stop and destroy this session? All data outside /workspace/projects will be lost.")) return;
    deleteSession.mutate({ sessionId }, {
      onSuccess: () => {
        toast({ title: "Session destroyed" });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      },
      onError: () => toast({ title: "Failed to stop session", variant: "destructive" }),
    });
  };

  const handleRefresh = () => {
    refreshStatus.mutate({ sessionId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) }),
      onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
    });
  };

  if (isLoading) {
    return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  }

  if (!session) {
    return <div className="p-8 text-destructive">Session not found</div>;
  }

  const isActive = session.status !== "stopped" && session.status !== "error";
  const isReady = session.status === "ready";

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">

      {/* Back */}
      <Button variant="ghost" className="gap-2 text-muted-foreground -ml-2" onClick={() => setLocation("/sessions")}>
        <ArrowLeft className="w-4 h-4" /> All Sessions
      </Button>

      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">Cockpit: {session.profileName}</h1>
            <SessionStatusBadge status={session.status} />
          </div>
          <p className="text-muted-foreground font-mono text-sm">
            Session #{session.id} · {session.gpuName} x{session.numGpus}
            {session.vastInstanceId ? ` · Vast #${session.vastInstanceId}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshStatus.isPending || !isActive}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${refreshStatus.isPending ? "animate-spin" : ""}`} />
            Sync
          </Button>
          {isActive && (
            <Button variant="destructive" size="sm" onClick={handleStop} disabled={deleteSession.isPending}>
              <StopCircle className="w-4 h-4 mr-1.5" />
              Destroy
            </Button>
          )}
        </div>
      </div>

      {/* Status message */}
      {session.statusMessage && (
        <div className="bg-secondary/30 border border-secondary p-4 rounded-md font-mono text-sm text-muted-foreground">
          {'>'} {session.statusMessage}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/50">
        <button
          onClick={() => setActiveTab("overview")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "overview"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => { setActiveTab("memory"); setNewObsCount(0); }}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
            activeTab === "memory"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Brain className="w-3.5 h-3.5" />
          Memory
          {newObsCount > 0 && (
            <span className="ml-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-none animate-badge-pop">
              {newObsCount > 99 ? "99+" : newObsCount}
            </span>
          )}
        </button>
      </div>

      {activeTab === "overview" && (
        <>
          {/* Primary launch — shown when ready */}
          {isReady && session.boltDiyUrl ? (
            <Card className="border-primary/60 bg-primary/5">
              <CardContent className="pt-6 pb-6 flex flex-col items-center gap-4 text-center">
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
                  <Terminal className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold mb-1">Your coding environment is ready</h2>
                  <p className="text-sm text-muted-foreground">
                    Bolt.diy with Kimi K2.5 AI — editor, terminal, and live preview all in one.
                  </p>
                </div>
                <Button
                  size="lg"
                  className="gap-2 px-8"
                  onClick={() => window.open(session.boltDiyUrl || "", "_blank")}
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Coding Environment
                </Button>
              </CardContent>
            </Card>
          ) : isActive ? (
            <Card className="border-border/50 bg-card/50">
              <CardContent className="pt-6 pb-6 flex flex-col items-center gap-3 text-center text-muted-foreground">
                <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
                  <Terminal className="w-6 h-6 animate-pulse" />
                </div>
                <p className="text-sm">Waiting for environment to start — this takes ~25 minutes on first launch while the model downloads.</p>
              </CardContent>
            </Card>
          ) : null}

          {/* Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                  <HardDrive className="w-4 h-4" /> Hardware & Access
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GPU</span>
                  <span className="font-mono">{session.gpuName || "—"} x{session.numGpus || "—"}</span>
                </div>
                <div className="flex justify-between border-t border-border/40 pt-3">
                  <span className="text-muted-foreground">Public IP</span>
                  <span className="font-mono">{session.publicIp || "Pending"}</span>
                </div>
                {session.sshHost && (
                  <div className="border-t border-border/40 pt-3">
                    <span className="text-muted-foreground block mb-1">SSH</span>
                    <code className="text-xs text-primary bg-secondary/50 px-2 py-1 rounded block break-all">
                      ssh -p {session.sshPort} root@{session.sshHost}
                    </code>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                  <DollarSign className="w-4 h-4" /> Cost & Timing
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Started</span>
                  <span className="font-mono">
                    {session.startedAt ? format(new Date(session.startedAt), "MMM d, HH:mm") : "—"}
                  </span>
                </div>
                <div className="flex justify-between border-t border-border/40 pt-3">
                  <span className="text-muted-foreground">Rate</span>
                  <span className="font-mono">${session.costPerHour?.toFixed(3) || "0.000"}/hr</span>
                </div>
                <div className="flex justify-between border-t border-border/40 pt-3">
                  <span className="text-muted-foreground">Total spend</span>
                  <span className="font-mono text-primary font-semibold">
                    ${session.totalCost?.toFixed(3) || "0.000"}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <div className={activeTab === "memory" ? "" : "hidden"}>
        <MemoryTab
          sessionId={sessionId}
          isActive={isActive}
          onNewObservation={activeTab !== "memory" ? () => setNewObsCount(prev => prev + 1) : undefined}
        />
      </div>

    </div>
  );
}
