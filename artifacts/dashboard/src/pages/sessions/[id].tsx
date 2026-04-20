import { useLocation, useParams } from "wouter";
import {
  useGetSession,
  useDeleteSession,
  useRefreshSessionStatus,
  useCreateSession,
  getGetSessionQueryKey,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Terminal, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, ExternalLink, ArrowLeft, Brain, ChevronDown, ChevronRight, Radio, Search, X, AlertTriangle, RotateCcw, Users, Copy, Check, Eye, EyeOff, FolderOpen
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface SearchResultObservation extends MemObservation {
  sessionSummary: string | null;
  sessionStartedAt: number;
}

interface MemorySearchResult {
  observations: SearchResultObservation[];
  sessions: MemSession[];
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

function useMemorySearch(sessionId: number, query: string) {
  return useQuery<MemorySearchResult>({
    queryKey: ["mem-search", sessionId, query],
    enabled: !!sessionId && query.trim().length > 1,
    queryFn: async () => {
      const url = `${BASE_URL}api/sessions/${sessionId}/memory/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to search memory");
      return res.json();
    },
    staleTime: 5000,
  });
}

function SearchResults({ results, isLoading }: { results: MemorySearchResult | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (!results) return null;

  const hasObs = results.observations.length > 0;
  const hasSess = results.sessions.length > 0;

  if (!hasObs && !hasSess) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">No results found.</p>
    );
  }

  return (
    <div className="space-y-4">
      {hasSess && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Matching Sessions ({results.sessions.length})
          </p>
          <div className="space-y-2">
            {results.sessions.map(sess => (
              <div key={sess.id} className="border border-primary/30 bg-primary/5 rounded p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] text-primary/60 bg-primary/10 rounded px-1">
                    {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{sess.observationCount} obs</span>
                </div>
                {sess.summary && (
                  <p className="text-xs text-foreground/90 leading-relaxed">{sess.summary}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {hasObs && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Matching Observations ({results.observations.length})
          </p>
          <div className="space-y-1.5">
            {results.observations.map(obs => (
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
                {obs.sessionSummary && (
                  <p className="text-muted-foreground/60 text-[10px] mt-1 border-t border-border/30 pt-1 truncate" title={obs.sessionSummary}>
                    Session: {obs.sessionSummary}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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

  // Search state
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput), 350);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  const isSearching = debouncedQuery.trim().length > 1;
  const { data: searchResults, isLoading: searchLoading } = useMemorySearch(sessionId, debouncedQuery);

  // Merge streamed + polled observations (deduped, sorted newest-first)
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

  const obsBySession = (observations || []).reduce<Record<string, MemObservation[]>>((acc, obs) => {
    if (!acc[obs.sessionId]) acc[obs.sessionId] = [];
    acc[obs.sessionId].push(obs);
    return acc;
  }, {});

  return (
    <div className="mt-4 space-y-3">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search session notes and tool observations…"
          className="pl-9 pr-9 bg-secondary/30 border-border/50 text-sm"
        />
        {searchInput && (
          <button
            onClick={() => setSearchInput("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Search results view */}
      {isSearching && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Search className="w-4 h-4" /> Search Results for &ldquo;{debouncedQuery}&rdquo;
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SearchResults results={searchResults} isLoading={searchLoading} />
          </CardContent>
        </Card>
      )}

      {/* Default view — shown when not searching */}
      {!isSearching && (
        <>
          {!hasSessions && !hasObservations && (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="pt-6 pb-6 text-center text-muted-foreground text-sm">
                <Brain className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p>No session memory recorded yet.</p>
                <p className="text-xs mt-1 opacity-70">Memory is captured automatically as the AI uses tools during a session.</p>
              </CardContent>
            </Card>
          )}

          {/* Past Session Summaries — shown first, prominently */}
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
                        </div>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-2">
                          {sess.observationCount} obs
                        </span>
                      </button>

                      {/* Summary block — always visible below header when summary exists */}
                      {sess.summary && (
                        <div className="mx-2 mb-2 px-2 py-1.5 bg-primary/5 border border-primary/20 rounded text-xs text-foreground/90 leading-relaxed">
                          {sess.summary}
                        </div>
                      )}

                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-1">
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
        </>
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
  const [badgePulseKey, setBadgePulseKey] = useState(0);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const lastBootMsgRef = useRef<string>("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Set<string>>(new Set());

  const copyToClipboard = (text: string, fieldId: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 1500);
    });
  };

  const toggleReveal = (fieldId: string) => {
    setRevealedPasswords((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  };

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
  const createSession = useCreateSession();
  const [isRetrying, setIsRetrying] = useState(false);

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

  const handleDestroyAndRetry = () => {
    if (!session?.profileId) return;
    setIsRetrying(true);
    deleteSession.mutate({ sessionId }, {
      onSuccess: () => {
        createSession.mutate({ data: { profileId: session.profileId } }, {
          onSuccess: (newSession) => {
            toast({ title: "Retrying on a new machine", description: "Launched a fresh instance." });
            queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
            setLocation(`/sessions/${newSession.id}`);
          },
          onError: () => {
            toast({ title: "Retry failed", description: "Could not launch a new session.", variant: "destructive" });
            setIsRetrying(false);
          },
        });
      },
      onError: () => {
        toast({ title: "Destroy failed", variant: "destructive" });
        setIsRetrying(false);
      },
    });
  };

  useEffect(() => {
    setBootLog([]);
    lastBootMsgRef.current = "";
  }, [sessionId]);

  useEffect(() => {
    const msg = session?.statusMessage;
    const status = session?.status;
    if (!msg || !status) return;
    const isBootPhase = ["pending", "provisioning", "downloading", "starting"].includes(status);
    if (!isBootPhase) return;
    if (msg === lastBootMsgRef.current) return;
    lastBootMsgRef.current = msg;
    setBootLog((prev) => [...prev.slice(-49), msg]);
  }, [session?.statusMessage, session?.status]);

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

      {/* Boot log / status message */}
      {bootLog.length > 0 ? (
        <div className="bg-secondary/30 border border-secondary rounded-md font-mono text-sm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-secondary/60 text-xs text-muted-foreground/60 uppercase tracking-wider">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
            Boot log
          </div>
          <div className="px-4 py-3 space-y-0.5 max-h-48 overflow-y-auto">
            {bootLog.map((line, i) => (
              <div key={i} className={`text-muted-foreground ${i === bootLog.length - 1 ? "text-foreground" : "opacity-60"}`}>
                <span className="text-primary/50 mr-2 select-none">›</span>{line}
              </div>
            ))}
          </div>
          {bootLog.some(l => l.toLowerCase().includes("no space left on device")) && (
            <div className="border-t border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-yellow-400 text-xs font-semibold">Host disk full</p>
                <p className="text-muted-foreground text-xs mt-0.5">The rented machine ran out of disk space pulling the Docker image. Destroy this session and retry — Vast.ai will pick a different host.</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/20 shrink-0"
                onClick={handleDestroyAndRetry}
                disabled={isRetrying}
              >
                <RotateCcw className={`w-3.5 h-3.5 mr-1.5 ${isRetrying ? "animate-spin" : ""}`} />
                {isRetrying ? "Retrying…" : "Destroy & Retry"}
              </Button>
            </div>
          )}
        </div>
      ) : session.statusMessage ? (
        <div className="bg-secondary/30 border border-secondary p-4 rounded-md font-mono text-sm text-muted-foreground">
          {'>'} {session.statusMessage}
        </div>
      ) : null}

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
          onClick={() => { setActiveTab("memory"); setNewObsCount(0); setBadgePulseKey(0); }}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
            activeTab === "memory"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Brain className="w-3.5 h-3.5" />
          Memory
          {isActive && newObsCount > 0 && (
            <span
              key={badgePulseKey}
              className={`ml-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-none ${badgePulseKey === 0 ? "animate-badge-pop" : "animate-badge-pulse"}`}
            >
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

          {/* Team Access — shown when session has non-shared team members */}
          {(() => {
            type TM = { name: string; password?: string | null; path: string; ideUrl?: string | null };
            const allMembers = (session.teamMembers as TM[] | null) ?? [];
            const namedMembers = allMembers.filter((m) => m.name !== "__shared__");
            const sharedEntry = allMembers.find((m) => m.name === "__shared__");

            const CredRow = ({ member }: { member: TM }) => {
              const urlField = `url-${member.name}`;
              const passField = `pass-${member.name}`;
              const revealed = revealedPasswords.has(passField);
              return (
                <div className="border border-border/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-primary uppercase">
                        {member.name === "__shared__" ? "S" : member.name[0]}
                      </span>
                    </div>
                    <span className="font-semibold text-sm capitalize">
                      {member.name === "__shared__" ? "Shared" : member.name}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-12 shrink-0">URL</span>
                      {member.ideUrl ? (
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <a
                            href={member.ideUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary font-mono truncate hover:underline flex-1 min-w-0"
                          >
                            {member.ideUrl}
                          </a>
                          <button
                            onClick={() => copyToClipboard(member.ideUrl!, urlField)}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            {copiedField === urlField ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Available once ready</span>
                      )}
                    </div>
                    {member.name === "__shared__" ? (
                      <div className="flex items-start gap-2 pt-0.5">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-12 shrink-0 pt-0.5">Auth</span>
                        <p className="text-xs text-muted-foreground italic flex-1">
                          Use your personal team IDE credentials to log in
                        </p>
                      </div>
                    ) : member.password ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-12 shrink-0">Pass</span>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <code className="text-xs font-mono text-primary flex-1 min-w-0">
                            {revealed ? member.password : "••••••••••••"}
                          </code>
                          <button
                            onClick={() => toggleReveal(passField)}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            title={revealed ? "Hide password" : "Show password"}
                          >
                            {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          </button>
                          <button
                            onClick={() => copyToClipboard(member.password!, passField + "-copy")}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            {copiedField === passField + "-copy" ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {member.ideUrl && (
                    <div className="pt-1">
                      <button
                        onClick={() => {
                          const text = member.password
                            ? `Your IDE: ${member.ideUrl} | Password: ${member.password}`
                            : `Your IDE: ${member.ideUrl}`;
                          const fieldId = `invite-${member.name}`;
                          navigator.clipboard.writeText(text).then(() => {
                            setCopiedField(fieldId);
                            setTimeout(() => setCopiedField(null), 1500);
                            toast({ title: "Invite link copied!", description: "Share this with your teammate to get them into their environment." });
                          }).catch(() => {
                            toast({ title: "Copy failed", description: "Could not access the clipboard. Try copying the fields manually.", variant: "destructive" });
                          });
                        }}
                        className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground border border-border/40 hover:border-border/70 rounded px-2 py-1 transition-colors"
                      >
                        {copiedField === `invite-${member.name}` ? (
                          <><Check className="w-3 h-3 text-emerald-500" /> Copied!</>
                        ) : (
                          <><Copy className="w-3 h-3" /> Copy invite</>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            };

            return (
              <>
                {namedMembers.length > 0 && (
                  <Card className="bg-card/50 border-border/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                        <Users className="w-4 h-4" /> Team Access
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {namedMembers.map((m) => <CredRow key={m.name} member={m} />)}
                      </div>
                    </CardContent>
                  </Card>
                )}
                {sharedEntry && (
                  <Card className="bg-card/50 border-border/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                        <FolderOpen className="w-4 h-4" /> Shared Workspace
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CredRow member={sharedEntry} />
                    </CardContent>
                  </Card>
                )}
              </>
            );
          })()}

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
          onNewObservation={activeTab !== "memory" ? () => setNewObsCount(prev => {
            if (prev > 0) setBadgePulseKey(k => k + 1);
            return prev + 1;
          }) : undefined}
        />
      </div>

    </div>
  );
}
