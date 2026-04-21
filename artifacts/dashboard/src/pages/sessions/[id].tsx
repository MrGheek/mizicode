import { useLocation, useParams } from "wouter";
import {
  useGetSession,
  useDeleteSession,
  useRefreshSessionStatus,
  useCreateSession,
  useGetSessionSkills,
  useSubmitSkillFeedback,
  useSessionCompleteFeedback,
  useGetSessionRoutingStats,
  useGetSessionConflicts,
  useGetSessionCoordination,
  getGetSessionQueryKey,
  getGetActiveSessionQueryKey,
  getGetSessionSkillsQueryKey,
  getGetSessionConflictsQueryKey,
  getGetSessionCoordinationQueryKey,
  useEnqueueRepoIndex,
  getGetRepoSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import {
  Terminal, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, ExternalLink, ArrowLeft, Brain, ChevronDown, ChevronRight, Radio, Search, X, AlertTriangle, RotateCcw, Users, Copy, Check, Eye, EyeOff, FolderOpen,
  Wand2, ThumbsUp, ThumbsDown, Wrench, GitBranch, Loader2, CheckCircle2, XCircle, AlertCircle, DatabaseZap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { SkillClassBadge, TrustBadge, TokenCostBadge, InstallRiskBadge } from "@/components/skill-badges";
import { useState, useEffect, useRef, useMemo } from "react";
import { TeamTab } from "@/components/team-tab";

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

type ManifestItem = {
  id?: string | number;
  manifestId?: string;
  name?: string;
  class?: string;
  trustTier?: string;
  installRisk?: string;
  tokenOverheadEstimate?: number;
  summary?: string;
  instructions?: { system?: string | string[] };
  sourceRepoUrl?: string;
  pinnedCommitSha?: string;
  license?: string;
};

function SmartSkillsTab({ sessionId, taskMode }: { sessionId: number; taskMode?: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetSessionSkills(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionSkillsQueryKey(sessionId) },
  });
  const submitFeedback = useSubmitSkillFeedback();
  const [votedSkills, setVotedSkills] = useState<Record<string | number, "up" | "down">>({});
  const [expandedSkills, setExpandedSkills] = useState<Set<string | number>>(new Set());
  const [comingSoonOpen, setComingSoonOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  const latestActivation = data?.activations?.[0] ?? null;
  const activeBundle = data?.activeBundle ?? null;
  const manifests = (data?.activeManifests ?? []) as ManifestItem[];

  if (!latestActivation && manifests.length === 0) {
    return (
      <div className="mt-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Wand2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p>No skills bundle was used in this session.</p>
            <p className="text-xs mt-1 opacity-70">Skills are applied when sessions are launched with Smart Skills enabled.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const toggleExpand = (id: string | number) => {
    setExpandedSkills(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleFeedback = (manifest: ManifestItem, helpful: boolean) => {
    const numericId = typeof manifest.id === "number" ? manifest.id : NaN;
    const manifestId = typeof manifest.id === "string"
      ? manifest.id
      : (manifest.manifestId ?? undefined);
    if (!numericId && !manifestId) {
      toast({ title: "Cannot submit feedback — skill ID missing", variant: "destructive" });
      return;
    }
    const data = numericId
      ? { skillId: numericId, helpful }
      : { manifestId, helpful };
    const voteKey = manifest.id ?? manifest.manifestId;
    submitFeedback.mutate({ sessionId, data }, {
      onSuccess: () => {
        if (voteKey !== undefined) {
          setVotedSkills(prev => ({ ...prev, [voteKey]: (helpful ? "up" : "down") as "up" | "down" }));
        }
        queryClient.invalidateQueries({ queryKey: getGetSessionSkillsQueryKey(sessionId) });
        toast({ title: helpful ? "Thumbs up recorded" : "Thumbs down recorded" });
      },
      onError: () => toast({ title: "Feedback failed", variant: "destructive" }),
    });
  };

  return (
    <div className="mt-4 space-y-4">
      {/* Bundle header */}
      {(activeBundle || latestActivation) && (
        <Card className="bg-card/50 border-border/50">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-primary" />
                <span className="font-semibold text-sm">
                  {activeBundle?.name ?? "Skills Bundle"}
                </span>
                {latestActivation?.activationMode && (
                  <Badge variant="outline" className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30">
                    {latestActivation.activationMode === "next-launch" ? "Next launch" : latestActivation.activationMode}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                {taskMode && (
                  <Badge variant="outline" className="text-[10px] capitalize">
                    Task: {taskMode}
                  </Badge>
                )}
                {latestActivation?.tokenMode && (
                  <Badge variant="outline" className="text-[10px] capitalize">{latestActivation.tokenMode} tokens</Badge>
                )}
                <span>{manifests.length} skills active</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Skill accordions */}
      <div className="space-y-2">
        {manifests.map((manifest, i) => {
          const skillId = manifest.id ?? manifest.manifestId ?? i;
          const isExpanded = expandedSkills.has(skillId);
          const vote = votedSkills[skillId];
          const rawSystem = manifest.instructions?.system;
          const instructionLines = Array.isArray(rawSystem)
            ? rawSystem.filter(Boolean)
            : String(rawSystem ?? "").split("\n").filter(Boolean);

          return (
            <Card key={skillId} className="bg-card/50 border-border/50">
              <button
                onClick={() => toggleExpand(skillId)}
                className="w-full px-4 py-3 text-left flex items-center justify-between gap-2 hover:bg-secondary/20 transition-colors rounded-t-lg"
              >
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  {manifest.class && <SkillClassBadge skillClass={manifest.class} />}
                  {manifest.trustTier && <TrustBadge trustTier={manifest.trustTier} />}
                  {manifest.installRisk && <InstallRiskBadge installRisk={manifest.installRisk} />}
                  {manifest.tokenOverheadEstimate != null && (
                    <TokenCostBadge tokens={manifest.tokenOverheadEstimate} />
                  )}
                  <span className="font-medium text-sm ml-1 truncate">{manifest.name ?? `Skill ${i + 1}`}</span>
                </div>
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
              </button>

              {isExpanded && (
                <CardContent className="pt-0 pb-4 space-y-3">
                  <div className="border-t border-border/40 pt-3 space-y-3">
                    {manifest.summary && (
                      <p className="text-sm text-muted-foreground">{manifest.summary}</p>
                    )}

                    {instructionLines.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Instructions</p>
                        <ul className="space-y-1">
                          {instructionLines.map((line, j) => (
                            <li key={j} className="text-xs text-foreground/80 flex items-start gap-2">
                              <span className="text-primary mt-0.5 shrink-0">›</span>
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(manifest.sourceRepoUrl || manifest.pinnedCommitSha || manifest.license) && (
                      <div className="rounded border border-border/40 bg-secondary/20 p-2.5 text-xs space-y-1">
                        <p className="font-semibold text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Source</p>
                        {manifest.sourceRepoUrl && (
                          <div className="flex items-center gap-1.5">
                            <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0" />
                            <a href={manifest.sourceRepoUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">
                              {manifest.sourceRepoUrl}
                            </a>
                          </div>
                        )}
                        {manifest.pinnedCommitSha && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">SHA:</span>
                            <code className="font-mono text-primary/80">{manifest.pinnedCommitSha.slice(0, 12)}</code>
                          </div>
                        )}
                        {manifest.license && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">License:</span>
                            <span className="text-foreground/80">{manifest.license}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Feedback + Replace */}
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-[10px] text-muted-foreground">Was this skill helpful?</span>
                      <button
                        disabled={!!vote || submitFeedback.isPending}
                        onClick={() => handleFeedback(manifest, true)}
                        className={`p-1 rounded transition-colors ${vote === "up" ? "text-emerald-400" : "text-muted-foreground hover:text-emerald-400 disabled:opacity-40"}`}
                        title="Thumbs up"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        disabled={!!vote || submitFeedback.isPending}
                        onClick={() => handleFeedback(manifest, false)}
                        className={`p-1 rounded transition-colors ${vote === "down" ? "text-red-400" : "text-muted-foreground hover:text-red-400 disabled:opacity-40"}`}
                        title="Thumbs down"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                      </button>
                      {vote && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          {vote === "up" ? "👍 Marked helpful" : "👎 Marked unhelpful"}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto text-[10px] h-6 px-2 text-muted-foreground gap-1"
                        onClick={() => setComingSoonOpen(true)}
                      >
                        <Wrench className="w-3 h-3" /> Replace skill
                      </Button>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      {/* Coming soon sheet */}
      <Sheet open={comingSoonOpen} onOpenChange={setComingSoonOpen}>
        <SheetContent side="right" className="w-[360px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Wrench className="w-4 h-4" /> Replace Skill
            </SheetTitle>
          </SheetHeader>
          <div className="mt-6 space-y-3">
            <div className="rounded border border-border/40 bg-secondary/20 p-4 text-sm text-muted-foreground text-center">
              <Wand2 className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="font-semibold text-foreground mb-1">Coming in the next release</p>
              <p>Live skill replacement on a running session will let you hot-swap skills without restarting. This feature is available in v2.</p>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface RepoSummaryExt {
  sessionId: number;
  indexStatus: string;
  isStale: boolean;
  confidenceLevel: string;
  summary: null | {
    architectureSketch: string;
    majorModules: { name: string; path: string; fileCount: number; primaryLang?: string | null }[];
    hotspots: { path: string; score: number; lang?: string | null }[];
    testStrategy?: string | null;
    complexityClass?: string | null;
  };
  indexedAt: string | null;
  symbolCount: number;
  chunkCount: number;
  fileCount: number;
  repoPath: string | null;
}

const ACTIVE_STATUSES = ["queued", "scanning", "fingerprinting", "indexing_graph", "indexing_fts", "indexing_vectors", "summarizing"];

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    none: "Not indexed",
    queued: "Queued",
    scanning: "Scanning files",
    fingerprinting: "Fingerprinting",
    indexing_graph: "Building graph",
    indexing_fts: "Full-text index",
    indexing_vectors: "Vector index",
    summarizing: "Summarizing",
    ready: "Ready",
    stale: "Stale",
    error: "Error",
  };
  return map[status] ?? status;
}

function StatusIcon({ status }: { status: string }) {
  if (ACTIVE_STATUSES.includes(status)) {
    return <Loader2 className="w-4 h-4 animate-spin text-primary" />;
  }
  if (status === "ready") return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  if (status === "stale") return <AlertCircle className="w-4 h-4 text-yellow-400" />;
  if (status === "error") return <XCircle className="w-4 h-4 text-destructive" />;
  return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
}

function IndexProgressBar({ status }: { status: string }) {
  const steps = ["queued", "scanning", "fingerprinting", "indexing_graph", "indexing_fts", "indexing_vectors", "summarizing", "ready"];
  const idx = steps.indexOf(status);
  if (idx < 0) return null;
  const pct = Math.round(((idx + 1) / steps.length) * 100);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
        <span>Indexing in progress…</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RepoIndexTab({ sessionId }: { sessionId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isActive = (status: string) => ACTIVE_STATUSES.includes(status);

  const { data: summary, isLoading, isError: isFetchError } = useQuery<RepoSummaryExt>({
    queryKey: getGetRepoSummaryQueryKey(sessionId),
    queryFn: async ({ signal }) => {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/repo/summary`, { signal });
      if (!res.ok) throw new Error("Failed to fetch repo summary");
      return res.json();
    },
    enabled: !!sessionId,
    refetchInterval: (q) => {
      const st = (q.state.data as RepoSummaryExt | undefined)?.indexStatus;
      return st && isActive(st) ? 3000 : 15000;
    },
  });

  const enqueue = useEnqueueRepoIndex();

  const handleReindex = () => {
    enqueue.mutate(
      { sessionId, data: { repoPath: summary?.repoPath ?? undefined } },
      {
        onSuccess: () => {
          toast({ title: "Re-index triggered", description: "Indexing job enqueued — this may take a few minutes." });
          queryClient.invalidateQueries({ queryKey: getGetRepoSummaryQueryKey(sessionId) });
        },
        onError: () => toast({ title: "Failed to trigger re-index", variant: "destructive" }),
      }
    );
  };

  if (isLoading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  if (isFetchError) {
    return (
      <div className="mt-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            <XCircle className="w-8 h-8 mx-auto mb-3 text-destructive/60" />
            <p className="text-sm">Failed to load repo index status.</p>
            <p className="text-xs mt-1 opacity-70">Check your network connection or try refreshing the page.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = summary?.indexStatus ?? "none";
  const isIndexing = isActive(status);
  const isReady = status === "ready";
  const isError = status === "error";
  const isStale = summary?.isStale ?? false;

  return (
    <div className="mt-4 space-y-4">
      {/* Status card */}
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
            <GitBranch className="w-4 h-4" /> Repository Index
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status row */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <StatusIcon status={status} />
              <span className="font-semibold text-sm">{statusLabel(status)}</span>
              {isStale && (
                <Badge variant="outline" className="text-[10px] bg-yellow-500/15 text-yellow-400 border-yellow-500/40 gap-1">
                  <AlertCircle className="w-2.5 h-2.5" /> Stale
                </Badge>
              )}
              {isReady && (
                <Badge variant="outline" className="text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/40">
                  {summary?.confidenceLevel === "full" ? "Full index" : summary?.confidenceLevel === "partial" ? "Partial" : "Fingerprint only"}
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-7 text-xs"
              onClick={handleReindex}
              disabled={enqueue.isPending || isIndexing}
            >
              {(enqueue.isPending || isIndexing) ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {isIndexing ? "Indexing…" : "Re-index"}
            </Button>
          </div>

          {/* Progress bar during active indexing */}
          {isIndexing && <IndexProgressBar status={status} />}

          {/* Stats grid */}
          {(isReady || (summary?.symbolCount ?? 0) > 0) && (
            <div className="grid grid-cols-3 gap-3 pt-1">
              <div className="bg-secondary/30 rounded p-2.5 text-center">
                <p className="text-lg font-bold text-foreground leading-none">{(summary?.symbolCount ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Symbols</p>
              </div>
              <div className="bg-secondary/30 rounded p-2.5 text-center">
                <p className="text-lg font-bold text-foreground leading-none">{(summary?.fileCount ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Files</p>
              </div>
              <div className="bg-secondary/30 rounded p-2.5 text-center">
                <p className="text-lg font-bold text-foreground leading-none">{(summary?.chunkCount ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Chunks</p>
              </div>
            </div>
          )}

          {/* Last indexed */}
          {summary?.indexedAt && (
            <p className="text-xs text-muted-foreground">
              Last indexed{" "}
              <span className="text-foreground">
                {formatDistanceToNow(new Date(summary.indexedAt), { addSuffix: true })}
              </span>
              {" "}— {format(new Date(summary.indexedAt), "MMM d, HH:mm")}
            </p>
          )}

          {/* Repo path */}
          {summary?.repoPath && (
            <p className="text-xs text-muted-foreground font-mono truncate">
              <span className="text-muted-foreground/60">Path: </span>{summary.repoPath}
            </p>
          )}

          {/* Error note */}
          {isError && (
            <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded p-2.5 text-xs text-destructive">
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Indexing failed. Click Re-index to retry.</span>
            </div>
          )}

          {/* No index yet */}
          {status === "none" && (
            <div className="text-center py-4 text-muted-foreground text-sm">
              <DatabaseZap className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>This repository has not been indexed yet.</p>
              <p className="text-xs mt-1 opacity-70">Indexing extracts symbols, file structure, and architecture insights.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Architecture summary */}
      {isReady && summary?.summary && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Brain className="w-4 h-4" /> Architecture Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {summary.summary.architectureSketch && (
              <p className="text-sm text-foreground/90 leading-relaxed">{summary.summary.architectureSketch}</p>
            )}
            {summary.summary.complexityClass && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Complexity:</span>
                <Badge variant="outline" className="text-[10px]">
                  {summary.summary.complexityClass}
                </Badge>
              </div>
            )}
            {summary.summary.majorModules.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Major Modules</p>
                <div className="space-y-1.5">
                  {summary.summary.majorModules.slice(0, 8).map((mod, i) => (
                    <div key={i} className="flex items-center justify-between text-xs border border-border/40 rounded px-2 py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-primary truncate">{mod.path}</span>
                        {mod.primaryLang && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0">{mod.primaryLang}</Badge>
                        )}
                      </div>
                      <span className="text-muted-foreground shrink-0 ml-2">{mod.fileCount} files</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.summary.hotspots.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Hot Files</p>
                <div className="space-y-1">
                  {summary.summary.hotspots.slice(0, 5).map((h, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground bg-secondary/20 rounded px-2 py-1">
                      <span className="text-primary/60 w-4 shrink-0">{i + 1}.</span>
                      <span className="truncate flex-1">{h.path}</span>
                      {h.lang && <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">{h.lang}</Badge>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.summary.testStrategy && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Test Strategy</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{summary.summary.testStrategy}</p>
              </div>
            )}
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
  const [activeTab, setActiveTab] = useState<"overview" | "memory" | "smart-skills" | "repo" | "team">("overview");
  const [newObsCount, setNewObsCount] = useState(0);
  const [badgePulseKey, setBadgePulseKey] = useState(0);
  const [seenConflictFingerprint, setSeenConflictFingerprint] = useState<string>("");
  const [conflictBadgePulseKey, setConflictBadgePulseKey] = useState(0);
  const prevConflictFingerprintRef = useRef<string>("");
  const [dismissedConflictFingerprint, setDismissedConflictFingerprint] = useState<string>(() =>
    sessionId ? (sessionStorage.getItem(`conflict-dismissed:${sessionId}`) ?? "") : ""
  );
  const [seenHandoffCount, setSeenHandoffCount] = useState(0);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const lastBootMsgRef = useRef<string>("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Set<string>>(new Set());
  const [tunnelCopied, setTunnelCopied] = useState(false);

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
  const [stopRatingOpen, setStopRatingOpen] = useState(false);
  const completeFeedback = useSessionCompleteFeedback();

  // Fetch routing stats in the background so they are ready when the session stops.
  // bytesAvoided is passed to complete-feedback to signal context-shield-core effectiveness.
  const { data: routingStatsData } = useGetSessionRoutingStats(sessionId);
  const bytesAvoided = routingStatsData?.stats?.totalBytesAvoided;

  // Background conflict polling for the Team tab badge
  const { data: bgConflictsData } = useGetSessionConflicts(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionConflictsQueryKey(sessionId),
      refetchInterval: 20000,
    },
  });

  // Background coordination polling for the handoff notification badge
  const { data: bgCoordData } = useGetSessionCoordination(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionCoordinationQueryKey(sessionId),
      refetchInterval: 20000,
    },
  });
  const bgPendingHandoffs = bgCoordData?.pendingHandoffs ?? 0;

  const activeConflicts = (bgConflictsData?.conflicts ?? []).filter(
    (c) => c.recommendation !== "no_conflict"
  );
  const hasBlockingConflict = activeConflicts.some((c) => c.recommendation === "block");
  const blockingConflictCount = activeConflicts.filter((c) => c.recommendation === "block").length;
  const hasAnyConflict = activeConflicts.length > 0;

  const conflictFingerprint = useMemo(
    () =>
      activeConflicts
        .map((c) => {
          const [a, b] = [c.laneIdA, c.laneIdB].sort((x, y) => x - y);
          return `${a}:${b}:${c.recommendation}`;
        })
        .sort()
        .join("|"),
    [activeConflicts]
  );

  const blockingConflictFingerprint = useMemo(
    () =>
      activeConflicts
        .filter((c) => c.recommendation === "block")
        .map((c) => {
          const [a, b] = [c.laneIdA, c.laneIdB].sort((x, y) => x - y);
          return `${a}:${b}`;
        })
        .sort()
        .join("|"),
    [activeConflicts]
  );

  useEffect(() => {
    setSeenConflictFingerprint("");
    setDismissedConflictFingerprint(
      sessionId ? (sessionStorage.getItem(`conflict-dismissed:${sessionId}`) ?? "") : ""
    );
  }, [sessionId]);

  useEffect(() => {
    if (!hasAnyConflict) {
      setSeenConflictFingerprint("");
      setDismissedConflictFingerprint("");
    }
  }, [hasAnyConflict]);

  useEffect(() => {
    if (activeTab === "team" && hasAnyConflict) {
      setSeenConflictFingerprint(conflictFingerprint);
    }
  }, [activeTab, conflictFingerprint, hasAnyConflict]);

  const showConflictBadge = hasAnyConflict && conflictFingerprint !== seenConflictFingerprint;

  useEffect(() => {
    const prev = prevConflictFingerprintRef.current;
    prevConflictFingerprintRef.current = conflictFingerprint;
    if (showConflictBadge && prev !== "" && prev !== conflictFingerprint) {
      setConflictBadgePulseKey((k) => k + 1);
    }
  }, [conflictFingerprint, showConflictBadge]);

  useEffect(() => {
    if (!showConflictBadge) {
      setConflictBadgePulseKey(0);
      prevConflictFingerprintRef.current = "";
    }
  }, [showConflictBadge]);

  // When the Team tab is opened, mark current pending handoffs as seen.
  // When handoffs are all resolved (count hits 0), reset seen count too.
  useEffect(() => {
    if (activeTab === "team") {
      setSeenHandoffCount(bgPendingHandoffs);
    }
  }, [activeTab, bgPendingHandoffs]);

  useEffect(() => {
    if (bgPendingHandoffs === 0) {
      setSeenHandoffCount(0);
    }
  }, [bgPendingHandoffs]);

  // Reset on session change
  useEffect(() => {
    setSeenHandoffCount(0);
  }, [sessionId]);

  const pendingHandoffBadgeCount = bgPendingHandoffs > seenHandoffCount
    ? bgPendingHandoffs - seenHandoffCount
    : 0;
  const showHandoffBadge = pendingHandoffBadgeCount > 0 && activeTab !== "team";

  const doStop = (taskSuccessScore?: number) => {
    if (taskSuccessScore !== undefined) {
      const feedbackPayload = {
        taskSuccessScore,
        ...(bytesAvoided !== undefined && bytesAvoided > 0 ? { bytesAvoided } : {}),
      };
      completeFeedback.mutate({ sessionId, data: feedbackPayload }, {
        onSettled: () => {
          deleteSession.mutate({ sessionId }, {
            onSuccess: () => {
              toast({ title: "Session destroyed" });
              queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
            },
            onError: () => toast({ title: "Failed to stop session", variant: "destructive" }),
          });
        },
      });
    } else if (bytesAvoided !== undefined && bytesAvoided > 0) {
      // No user rating, but we have routing stats — still submit the implicit signal
      // for context-shield-core so it benefits from real bytesAvoided data.
      completeFeedback.mutate({ sessionId, data: { bytesAvoided } }, {
        onSettled: () => {
          deleteSession.mutate({ sessionId }, {
            onSuccess: () => {
              toast({ title: "Session destroyed" });
              queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
            },
            onError: () => toast({ title: "Failed to stop session", variant: "destructive" }),
          });
        },
      });
    } else {
      deleteSession.mutate({ sessionId }, {
        onSuccess: () => {
          toast({ title: "Session destroyed" });
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
        },
        onError: () => toast({ title: "Failed to stop session", variant: "destructive" }),
      });
    }
  };

  const handleStop = () => {
    setStopRatingOpen(true);
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
        <button
          onClick={() => setActiveTab("smart-skills")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
            activeTab === "smart-skills"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Wand2 className="w-3.5 h-3.5" />
          Smart Skills
        </button>
        <button
          onClick={() => setActiveTab("repo")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
            activeTab === "repo"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <GitBranch className="w-3.5 h-3.5" />
          Repo Index
        </button>
        <button
          onClick={() => { setActiveTab("team"); setSeenConflictFingerprint(conflictFingerprint); setSeenHandoffCount(bgPendingHandoffs); }}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
            activeTab === "team"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Team
          {showConflictBadge && (
            <span
              key={conflictBadgePulseKey}
              className={`ml-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full text-[10px] font-semibold leading-none ${conflictBadgePulseKey === 0 ? "animate-badge-pop" : "animate-badge-pulse"} ${
                hasBlockingConflict
                  ? "bg-red-500 text-white"
                  : "bg-yellow-500 text-black"
              }`}
            >
              {hasBlockingConflict ? activeConflicts.filter(c => c.recommendation === "block").length : activeConflicts.length}
            </span>
          )}
          {showHandoffBadge && (
            <span className="ml-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-none animate-badge-pop">
              {pendingHandoffBadgeCount > 99 ? "99+" : pendingHandoffBadgeCount}
            </span>
          )}
        </button>
      </div>

      {activeTab === "overview" && (
        <>
          {/* Blocking conflict banner */}
          {hasBlockingConflict && dismissedConflictFingerprint !== blockingConflictFingerprint && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
              <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <span className="flex-1 text-red-300">
                <span className="font-semibold text-red-200">
                  {blockingConflictCount} blocking {blockingConflictCount === 1 ? "conflict" : "conflicts"} detected.
                </span>{" "}
                Team members are working on overlapping files.{" "}
                <button
                  className="underline underline-offset-2 font-medium text-red-200 hover:text-white transition-colors"
                  onClick={() => { setActiveTab("team"); setSeenConflictFingerprint(conflictFingerprint); }}
                >
                  View in Team tab
                </button>
              </span>
              <button
                aria-label="Dismiss conflict banner"
                className="text-red-400 hover:text-red-200 transition-colors ml-1 shrink-0"
                onClick={() => {
                  sessionStorage.setItem(`conflict-dismissed:${sessionId}`, blockingConflictFingerprint);
                  setDismissedConflictFingerprint(blockingConflictFingerprint);
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

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
                    Bolt.diy with Kimi K2.6 AI — editor, terminal, and live preview all in one.
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
                {session.sshHost && (
                  <div className="border-t border-border/40 pt-3 space-y-2">
                    <span className="text-muted-foreground block mb-1">SSH Tunnel (VPN-friendly)</span>
                    <code className="text-xs text-primary bg-secondary/50 px-2 py-1 rounded block break-all">
                      ssh -p {session.sshPort} -L 8080:localhost:8080 root@{session.sshHost}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-7"
                      onClick={() => {
                        navigator.clipboard.writeText(`ssh -p ${session.sshPort} -L 8080:localhost:8080 root@${session.sshHost}`).then(() => {
                          setTunnelCopied(true);
                          setTimeout(() => setTunnelCopied(false), 2000);
                        });
                      }}
                    >
                      {tunnelCopied ? (
                        <><Check className="w-3 h-3 mr-1" />Copied!</>
                      ) : (
                        <><Copy className="w-3 h-3 mr-1" />Copy tunnel command</>
                      )}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      After running, open{" "}
                      <span className="font-mono text-primary">http://localhost:8080</span>{" "}
                      in your browser.
                    </p>
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

      {activeTab === "smart-skills" && (
        <SmartSkillsTab sessionId={sessionId} taskMode={session.taskMode ?? null} />
      )}

      {activeTab === "repo" && (
        <RepoIndexTab sessionId={sessionId} />
      )}

      {activeTab === "team" && (
        <TeamTab sessionId={sessionId} />
      )}

      {stopRatingOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setStopRatingOpen(false); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <StopCircle className="w-4 h-4 text-destructive" />
                Stop session
              </DialogTitle>
            </DialogHeader>
            <div className="py-2 space-y-3">
              <p className="text-sm text-muted-foreground">
                All data outside <code className="bg-secondary px-1 rounded text-xs">/workspace/projects</code> will be lost.
              </p>
              <p className="text-sm font-medium">How did this session go?</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 h-9 gap-2 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border-emerald-600/30"
                  onClick={() => { setStopRatingOpen(false); doStop(5); }}
                  disabled={deleteSession.isPending || completeFeedback.isPending}
                >
                  <ThumbsUp className="w-4 h-4" /> Went well
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 h-9 gap-2 bg-red-600/10 hover:bg-red-600/20 text-red-400 border-red-600/30"
                  onClick={() => { setStopRatingOpen(false); doStop(1); }}
                  disabled={deleteSession.isPending || completeFeedback.isPending}
                >
                  <ThumbsDown className="w-4 h-4" /> Had issues
                </Button>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStopRatingOpen(false)}>Cancel</Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { setStopRatingOpen(false); doStop(); }}
                disabled={deleteSession.isPending}
              >
                Stop without rating
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

    </div>
  );
}
