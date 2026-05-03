import { useLocation, useParams } from "wouter";
import {
  useGetSession,
  useUpdateSession,
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
  useGetRepoFingerprint,
  useSearchRepo,
  useGetRepoBlastRadius,
  useGetRepoSymbol,
  getGetRepoSummaryQueryKey,
  getGetRepoFingerprintQueryKey,
  useAcknowledgeLaneHandoff,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import {
  Terminal, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, ExternalLink, ArrowLeft, Brain, ChevronDown, ChevronRight, Radio, Search, X, AlertTriangle, RotateCcw, Users, Copy, Check, Eye, EyeOff, FolderOpen,
  Wand2, ThumbsUp, ThumbsDown, Wrench, GitBranch, Loader2, CheckCircle2, XCircle, AlertCircle, DatabaseZap, Network, Target, Pencil,
  // RotateCcw was used by the legacy disk-full retry button; the new BootTimeline owns that CTA.
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { SkillClassBadge, TrustBadge, TokenCostBadge, InstallRiskBadge } from "@/components/skill-badges";
import { useState, useEffect, useRef, useMemo } from "react";
import { useListProfiles } from "@workspace/api-client-react";
import { inferBootPhase } from "@/lib/boot-phases";
import { BootTimeline, BootProgressStrip } from "@/components/boot-timeline";
import { RelaunchButton } from "@/components/relaunch-button";
import { isTypingTarget } from "@/lib/shortcuts";
import { TeamTab } from "@/components/team-tab";
import { SwarmActivityPanel, useSwarmStatus, swarmTabBadgeLabel, swarmTabIsActive, swarmTabShouldShow } from "@/components/swarm-activity-panel";

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
  totalObservations: number;
  totalSessions: number;
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

function useMemoryProjectPaths(sessions: MemSession[] | undefined): string[] {
  return useMemo(() => {
    if (!sessions) return [];
    return [...new Set(sessions.map(s => s.projectPath).filter(Boolean))].sort();
  }, [sessions]);
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
// Polling cadence for active sessions (must match refetchInterval in useGetSession).
const SESSION_POLL_MS = 5000;
// How long terminal status must persist before the SSE feed is closed.
// Must be > SESSION_POLL_MS so a genuine transition survives at least one extra poll.
const MEM_FEED_CONFIRM_MS = SESSION_POLL_MS + 2000;

const MEM_PAGE_SIZE = 30;

function useMemorySearch(sessionId: number, query: string, projectPath: string, offset: number) {
  return useQuery<MemorySearchResult>({
    queryKey: ["mem-search", sessionId, query, projectPath, offset],
    enabled: !!sessionId && query.trim().length > 1,
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, limit: String(MEM_PAGE_SIZE), offset: String(offset) });
      if (projectPath) params.set("projectPath", projectPath);
      const url = `${BASE_URL}api/sessions/${sessionId}/memory/search?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to search memory");
      return res.json();
    },
    staleTime: 5000,
  });
}

function SearchResults({
  allObservations,
  allSessions,
  totalObservations,
  totalSessions,
  isLoading,
  isFetching,
  onLoadMore,
}: {
  allObservations: SearchResultObservation[];
  allSessions: MemSession[];
  totalObservations: number;
  totalSessions: number;
  isLoading: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const hasObs = allObservations.length > 0;
  const hasSess = allSessions.length > 0;

  if (!hasObs && !hasSess) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">No results found.</p>
    );
  }

  const hasMoreObs = allObservations.length < totalObservations;
  const hasMoreSess = allSessions.length < totalSessions;
  const hasMore = hasMoreObs || hasMoreSess;

  return (
    <div className="space-y-4">
      {hasSess && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Matching Sessions — showing {allSessions.length} of {totalSessions}
          </p>
          <div className="space-y-2">
            {allSessions.map(sess => (
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
            Matching Observations — showing {allObservations.length} of {totalObservations}
          </p>
          <div className="space-y-1.5">
            {allObservations.map(obs => (
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

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isFetching}
            className="gap-2"
          >
            {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function MemoryTab({
  sessionId,
  isActive,
  streaming,
  reconnecting,
  gaveUp,
  streamedObservations,
  onReconnect,
}: {
  sessionId: number;
  isActive: boolean;
  streaming: boolean;
  reconnecting: boolean;
  gaveUp: boolean;
  streamedObservations: MemObservation[];
  onReconnect: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: sessions, isLoading: sessionsLoading } = useMemSessions(sessionId);
  const { data: polledObservations, isLoading: obsLoading } = useMemObservations(sessionId, isActive);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null);

  async function handleSaveSummary(memSessId: string) {
    setSavingSessionId(memSessId);
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/memory/sessions/${encodeURIComponent(memSessId)}/summary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: editDraft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Failed to save");
      }
      queryClient.invalidateQueries({ queryKey: ["mem-sessions", sessionId] });
      toast({ title: "Session note saved" });
      setEditingSessionId(null);
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Failed to save note", variant: "destructive" });
    } finally {
      setSavingSessionId(null);
    }
  }

  function startEdit(sess: MemSession) {
    setEditingSessionId(sess.id);
    setEditDraft(sess.summary ?? "");
  }

  // Project path filter
  const [selectedProject, setSelectedProject] = useState("");
  const projectPaths = useMemoryProjectPaths(sessions);

  // Search state
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchOffset, setSearchOffset] = useState(0);
  const [allSearchObs, setAllSearchObs] = useState<SearchResultObservation[]>([]);
  const [allSearchSessions, setAllSearchSessions] = useState<MemSession[]>([]);
  const [totalSearchObs, setTotalSearchObs] = useState(0);
  const [totalSearchSessions, setTotalSearchSessions] = useState(0);

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput), 350);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  // Reset pagination when query changes
  useEffect(() => {
    setSearchOffset(0);
    setAllSearchObs([]);
    setAllSearchSessions([]);
    setTotalSearchObs(0);
    setTotalSearchSessions(0);
  }, [debouncedQuery]);

  const isSearching = debouncedQuery.trim().length > 1;
  const { data: searchResults, isLoading: searchLoading, isFetching: searchFetching } = useMemorySearch(sessionId, debouncedQuery, selectedProject, searchOffset);

  // Accumulate search results across pages (dedup by id)
  useEffect(() => {
    if (!searchResults) return;
    setTotalSearchObs(searchResults.totalObservations);
    setTotalSearchSessions(searchResults.totalSessions);
    if (searchOffset === 0) {
      setAllSearchObs(searchResults.observations);
      setAllSearchSessions(searchResults.sessions);
    } else {
      setAllSearchObs(prev => {
        const seen = new Set(prev.map(o => o.id));
        return [...prev, ...searchResults.observations.filter(o => !seen.has(o.id))];
      });
      setAllSearchSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...searchResults.sessions.filter(s => !seen.has(s.id))];
      });
    }
  }, [searchResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge streamed + polled observations (deduped, sorted newest-first)
  const allObservations = (() => {
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

  // Apply project path filter client-side for sessions and observations
  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!selectedProject) return sessions;
    return sessions.filter(s => s.projectPath === selectedProject);
  }, [sessions, selectedProject]);

  const observations = useMemo(() => {
    if (!selectedProject) return allObservations;
    const sessionIds = new Set(filteredSessions.map(s => s.id));
    return allObservations.filter(o => sessionIds.has(o.sessionId));
  }, [allObservations, filteredSessions, selectedProject]);

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

  const hasSessions = filteredSessions.length > 0;
  const hasObservations = observations && observations.length > 0;

  const obsBySession = (observations || []).reduce<Record<string, MemObservation[]>>((acc, obs) => {
    if (!acc[obs.sessionId]) acc[obs.sessionId] = [];
    acc[obs.sessionId].push(obs);
    return acc;
  }, {});

  return (
    <div className="mt-4 space-y-3">
      {/* Live feed status row */}
      {isActive && (streaming || reconnecting || gaveUp) && (
        <div className="flex items-center gap-2 text-xs">
          {streaming && (
            <span className="flex items-center gap-1 text-emerald-500">
              <Radio className="w-3 h-3 animate-pulse" /> Live
            </span>
          )}
          {reconnecting && (
            <span className="flex items-center gap-1 text-amber-500">
              <RefreshCw className="w-3 h-3 animate-spin" /> Reconnecting…
            </span>
          )}
          {gaveUp && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              <span>Live feed disconnected.</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onReconnect}
              >
                <RefreshCw className="w-3 h-3 mr-1" /> Reconnect
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Filter + Search row */}
      <div className="flex gap-2 items-center">
        {/* Project path filter dropdown */}
        {projectPaths.length > 0 && (
          <div className="relative flex-shrink-0">
            <FolderOpen className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <select
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              className="pl-8 pr-8 py-2 text-xs rounded-md border border-border/50 bg-secondary/30 text-foreground appearance-none focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer min-w-[140px] max-w-[220px]"
            >
              <option value="">All projects</option>
              {projectPaths.map(p => (
                <option key={p} value={p}>{p.length > 28 ? `…${p.slice(-28)}` : p}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {/* Search bar */}
        <div className="relative flex-1">
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
      </div>

      {/* Active project filter badge */}
      {selectedProject && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtered by project:</span>
          <span className="inline-flex items-center gap-1 text-xs font-mono bg-primary/10 text-primary rounded px-2 py-0.5 border border-primary/20">
            <FolderOpen className="w-3 h-3" />
            {selectedProject.length > 36 ? `…${selectedProject.slice(-36)}` : selectedProject}
            <button
              onClick={() => setSelectedProject("")}
              className="ml-1 hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      {/* Search results view */}
      {isSearching && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Search className="w-4 h-4" /> Search Results for &ldquo;{debouncedQuery}&rdquo;
              {selectedProject && (
                <span className="ml-1 text-[10px] font-normal normal-case text-primary/70">
                  in {selectedProject.length > 22 ? `…${selectedProject.slice(-22)}` : selectedProject}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SearchResults
              allObservations={allSearchObs}
              allSessions={allSearchSessions}
              totalObservations={totalSearchObs}
              totalSessions={totalSearchSessions}
              isLoading={searchLoading && searchOffset === 0}
              isFetching={searchFetching}
              onLoadMore={() => setSearchOffset(prev => prev + MEM_PAGE_SIZE)}
            />
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
                {selectedProject ? (
                  <>
                    <p>No sessions found for this project.</p>
                    <p className="text-xs mt-1 opacity-70">Try selecting a different project or clear the filter.</p>
                  </>
                ) : (
                  <>
                    <p>No session memory recorded yet.</p>
                    <p className="text-xs mt-1 opacity-70">Memory is captured automatically as the AI uses tools during a session.</p>
                    {(streaming || reconnecting) && (
                      <div className="mt-3 flex items-center justify-center">
                        {streaming && (
                          <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                            <Radio className="w-3 h-3 animate-pulse" /> Live
                          </span>
                        )}
                        {reconnecting && !streaming && (
                          <span className="flex items-center gap-1 text-[11px] text-amber-500">
                            <RefreshCw className="w-3 h-3 animate-spin" /> Reconnecting…
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Past Session Summaries — shown first, prominently */}
          {hasSessions && (
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                  <Clock className="w-4 h-4" /> Session History
                  {!hasObservations && streaming && (
                    <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-emerald-500 normal-case tracking-normal">
                      <Radio className="w-3 h-3 animate-pulse" /> Live
                    </span>
                  )}
                  {!hasObservations && reconnecting && !streaming && (
                    <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-amber-500 normal-case tracking-normal">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Reconnecting…
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {filteredSessions.map(sess => {
                  const isExpanded = expandedSessions.has(sess.id);
                  const sessObs = obsBySession[sess.id] || [];
                  const isEditing = editingSessionId === sess.id;
                  const isSaving = savingSessionId === sess.id;
                  return (
                    <div key={sess.id} className="border border-border/40 rounded">
                      <div className="flex items-center gap-2 p-2">
                        <button
                          onClick={() => toggleSession(sess.id)}
                          className="flex items-center gap-2 flex-1 justify-between text-left hover:bg-secondary/20 transition-colors rounded min-w-0"
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
                        {!isEditing && (
                          <button
                            onClick={() => startEdit(sess)}
                            title={sess.summary ? "Edit session note" : "Add session note"}
                            className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      {/* Inline edit area */}
                      {isEditing ? (
                        <div className="mx-2 mb-2 space-y-1.5">
                          <textarea
                            value={editDraft}
                            onChange={e => setEditDraft(e.target.value)}
                            rows={4}
                            className="w-full text-xs rounded border border-primary/40 bg-primary/5 px-2.5 py-2 text-foreground/90 leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary/50"
                            placeholder="Write your session notes here…"
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="h-6 text-xs px-2 gap-1"
                              onClick={() => handleSaveSummary(sess.id)}
                              disabled={isSaving}
                            >
                              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-xs px-2"
                              onClick={() => setEditingSessionId(null)}
                              disabled={isSaving}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        /* Summary block — always visible below header when summary exists */
                        sess.summary && (
                          <div className="mx-2 mb-2 px-2 py-1.5 bg-primary/5 border border-primary/20 rounded text-xs text-foreground/90 leading-relaxed">
                            {sess.summary}
                          </div>
                        )
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
                  {reconnecting && !streaming && (
                    <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-amber-500 normal-case tracking-normal">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Reconnecting…
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

  const summaryStatus = summary?.indexStatus ?? "none";

  const { data: fingerprintData } = useGetRepoFingerprint(sessionId, {
    query: {
      enabled: !!sessionId,
      refetchInterval: isActive(summaryStatus) ? 5000 : false,
    },
  });
  const fingerprint = fingerprintData?.fingerprint;

  const handleReindex = () => {
    enqueue.mutate(
      { sessionId, data: { repoPath: summary?.repoPath ?? undefined } },
      {
        onSuccess: () => {
          toast({ title: "Re-index triggered", description: "Indexing job enqueued — this may take a few minutes." });
          queryClient.invalidateQueries({ queryKey: getGetRepoSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetRepoFingerprintQueryKey(sessionId) });
        },
        onError: () => toast({ title: "Failed to trigger re-index", variant: "destructive" }),
      }
    );
  };

  // Symbol / file search — persisted in sessionStorage across tab switches
  const [searchInput, setSearchInput] = useState<string>(() =>
    sessionStorage.getItem(`repo-search-query:${sessionId}`) ?? ""
  );
  const [debouncedQuery, setDebouncedQuery] = useState<string>(() =>
    (sessionStorage.getItem(`repo-search-query:${sessionId}`) ?? "").trim()
  );
  const [searchType, setSearchType] = useState<"all" | "symbol" | "file" | "chunk">("all");
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setDebouncedQuery(searchInput.trim()), 400);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchInput]);

  useEffect(() => {
    sessionStorage.setItem(`repo-search-query:${sessionId}`, searchInput);
  }, [searchInput, sessionId]);

  // Rehydrate search state if sessionId changes without a full remount
  useEffect(() => {
    const saved = sessionStorage.getItem(`repo-search-query:${sessionId}`) ?? "";
    setSearchInput(saved);
    setDebouncedQuery(saved.trim());
  }, [sessionId]);

  const searchEnabled = debouncedQuery.length > 0;
  const { data: searchData, isLoading: searchLoading, isFetching: searchFetching, isError: searchError } = useSearchRepo(
    sessionId,
    { q: debouncedQuery || "_", type: searchType === "all" ? undefined : searchType, limit: 20 },
    { query: { enabled: searchEnabled } },
  );

  // Symbol detail drawer
  const [selectedSymbol, setSelectedSymbol] = useState<{ name: string; path: string } | null>(null);
  const { data: symbolDetailData, isLoading: symbolDetailLoading } = useGetRepoSymbol(
    sessionId,
    selectedSymbol ? { name: selectedSymbol.name, path: selectedSymbol.path } : {},
    { query: { enabled: !!selectedSymbol } },
  );
  const symbolDetail = symbolDetailData?.symbols?.[0] ?? null;

  // Blast-radius lookup — persisted in sessionStorage across tab switches
  const [blastInput, setBlastInput] = useState<string>(() =>
    sessionStorage.getItem(`repo-blast-input:${sessionId}`) ?? ""
  );
  const [blastFile, setBlastFile] = useState<string>(() =>
    sessionStorage.getItem(`repo-blast-file:${sessionId}`) ?? ""
  );

  useEffect(() => {
    sessionStorage.setItem(`repo-blast-input:${sessionId}`, blastInput);
  }, [blastInput, sessionId]);

  useEffect(() => {
    sessionStorage.setItem(`repo-blast-file:${sessionId}`, blastFile);
  }, [blastFile, sessionId]);

  // Rehydrate blast state if sessionId changes without a full remount
  useEffect(() => {
    setBlastInput(sessionStorage.getItem(`repo-blast-input:${sessionId}`) ?? "");
    setBlastFile(sessionStorage.getItem(`repo-blast-file:${sessionId}`) ?? "");
  }, [sessionId]);

  const { data: blastData, isLoading: blastLoading, isError: blastError } = useGetRepoBlastRadius(
    sessionId,
    { file: blastFile || "_" },
    { query: { enabled: !!blastFile } },
  );

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
            <GitBranch className="w-4 h-4" /> Repo Intelligence
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
              {summary?.confidenceLevel && (
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    summary.confidenceLevel === "full" || summary.confidenceLevel === "partial"
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                      : summary.confidenceLevel === "fingerprint"
                      ? "bg-blue-500/15 text-blue-400 border-blue-500/40"
                      : "bg-secondary/40 text-muted-foreground border-border/50"
                  }`}
                >
                  {summary.confidenceLevel === "full"
                    ? "Full index"
                    : summary.confidenceLevel === "partial"
                    ? "Partial"
                    : summary.confidenceLevel === "fingerprint"
                    ? "Fingerprint only"
                    : "None"}
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
              {isIndexing ? "Indexing…" : status === "none" ? "Index Repo" : "Re-index"}
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

          {/* Detected environment (from fingerprint) */}
          {fingerprint && (fingerprint.primaryLangs.length > 0 || fingerprint.frameworks.length > 0) && (
            <div className="space-y-2">
              {fingerprint.primaryLangs.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Languages</p>
                  <div className="flex flex-wrap gap-1">
                    {fingerprint.primaryLangs.map((lang) => (
                      <Badge key={lang} variant="outline" className="text-[10px] px-1.5 py-0">
                        {lang}
                      </Badge>
                    ))}
                    {fingerprint.allLangs.filter(l => !fingerprint.primaryLangs.includes(l)).map((lang) => (
                      <Badge key={lang} variant="outline" className="text-[10px] px-1.5 py-0 opacity-60">
                        {lang}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {fingerprint.frameworks.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Frameworks</p>
                  <div className="flex flex-wrap gap-1">
                    {fingerprint.frameworks.map((fw) => (
                      <Badge key={fw} variant="outline" className="text-[10px] px-1.5 py-0 bg-primary/5 border-primary/20 text-primary/80">
                        {fw}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {(fingerprint.packageManager || fingerprint.monorepo) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {fingerprint.packageManager && (
                    <span>Package manager: <span className="text-foreground font-mono">{fingerprint.packageManager}</span></span>
                  )}
                  {fingerprint.monorepo && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">Monorepo</Badge>
                  )}
                </div>
              )}
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

      {/* Symbol / file search */}
      <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Search className="w-4 h-4" /> Search Codebase
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {status === "none" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary/20 rounded p-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span>Index the repo first to enable search.</span>
              </div>
            )}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder="Search symbols, files, or code chunks…"
                  className="pl-9 pr-9 bg-secondary/30 border-border/50 text-sm"
                  disabled={status === "none" || isIndexing}
                />
                {searchInput && (
                  <button
                    onClick={() => { setSearchInput(""); setDebouncedQuery(""); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <select
                value={searchType}
                onChange={e => setSearchType(e.target.value as "all" | "symbol" | "file" | "chunk")}
                disabled={status === "none" || isIndexing}
                className="px-2 py-1.5 text-xs rounded-md border border-border/50 bg-secondary/30 text-foreground appearance-none focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer min-w-[84px] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="all">All types</option>
                <option value="symbol">Symbols</option>
                <option value="file">Files</option>
                <option value="chunk">Chunks</option>
              </select>
            </div>

            {searchEnabled && (
              <>
                {(searchLoading || searchFetching) && !searchData && (
                  <div className="space-y-1.5">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
                  </div>
                )}
                {searchError && !searchLoading && (
                  <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2.5">
                    <XCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>Search failed. The repo may not be indexed or the server is unavailable.</span>
                  </div>
                )}
                {!searchError && searchData && searchData.results.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">No results for &ldquo;{debouncedQuery}&rdquo;.</p>
                )}
                {searchData && searchData.results.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      {searchData.total.toLocaleString()} result{searchData.total !== 1 ? "s" : ""} — showing {searchData.results.length}
                      {searchFetching && <Loader2 className="inline w-3 h-3 ml-1 animate-spin" />}
                    </p>
                    {searchData.results.map((r, i) => {
                      const isSymbol = r.type === "symbol";
                      return (
                        <div
                          key={i}
                          className={`border border-border/40 rounded px-2.5 py-2 text-xs font-mono${isSymbol ? " cursor-pointer hover:bg-secondary/30 hover:border-border/70 transition-colors" : ""}`}
                          onClick={isSymbol && r.name ? () => setSelectedSymbol({ name: r.name!, path: r.path }) : undefined}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="text-[9px] px-1 py-0 capitalize shrink-0">
                              {r.type}
                            </Badge>
                            {r.kind && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 bg-primary/5 border-primary/20 text-primary/80">
                                {r.kind}
                              </Badge>
                            )}
                            {r.lang && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                                {r.lang}
                              </Badge>
                            )}
                            {r.name && (
                              <span className="font-semibold text-foreground truncate">{r.name}</span>
                            )}
                            <span className="text-muted-foreground truncate flex-1">{r.path}{r.line != null ? `:${r.line}` : ""}</span>
                            <span className="text-muted-foreground/60 shrink-0 ml-auto">{Math.round((r.scores.combined ?? 0) * 100)}%</span>
                          </div>
                          {r.snippet && (
                            <p className="mt-1 text-muted-foreground/80 truncate text-[10px]">{r.snippet}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

      {/* Blast-radius lookup */}
      <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Network className="w-4 h-4" /> Blast Radius
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">Enter a file path to see which files depend on it and which tests may be affected.</p>
            {status === "none" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary/20 rounded p-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span>Index the repo first to enable blast-radius lookup.</span>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={blastInput}
                onChange={e => setBlastInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && blastInput.trim() && status !== "none" && !isIndexing) setBlastFile(blastInput.trim()); }}
                placeholder="e.g. src/utils/helpers.ts"
                className="flex-1 bg-secondary/30 border-border/50 text-sm font-mono"
                disabled={status === "none" || isIndexing}
              />
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5 h-9 text-xs"
                onClick={() => { if (blastInput.trim()) setBlastFile(blastInput.trim()); }}
                disabled={!blastInput.trim() || blastLoading || status === "none" || isIndexing}
              >
                {blastLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Lookup
              </Button>
            </div>

            {blastFile && blastLoading && (
              <div className="space-y-1.5">
                {[1, 2].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            )}

            {blastFile && blastError && !blastLoading && (
              <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2.5">
                <XCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Blast-radius lookup failed. The repo may not be indexed or the file path may not exist.</span>
              </div>
            )}

            {!blastError && blastData && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground font-mono truncate flex-1">{blastData.file}</span>
                  <Badge variant="outline" className="text-[9px] px-1.5 shrink-0">
                    {Math.round(blastData.overallConfidence * 100)}% confidence
                  </Badge>
                </div>

                {blastData.directDependents.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Direct Dependents ({blastData.directDependents.length})</p>
                    <div className="space-y-1">
                      {blastData.directDependents.map((dep, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] font-mono bg-secondary/20 rounded px-2 py-1">
                          <span className="truncate flex-1 text-foreground/90">{dep.path}</span>
                          <span className="text-muted-foreground/60 shrink-0">{Math.round(dep.confidence * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {blastData.affectedTests.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Affected Tests ({blastData.affectedTests.length})</p>
                    <div className="space-y-1">
                      {blastData.affectedTests.map((t, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] font-mono bg-emerald-500/5 border border-emerald-500/20 rounded px-2 py-1">
                          <span className="truncate flex-1 text-emerald-400/90">{t.path}</span>
                          <span className="text-muted-foreground/60 shrink-0">{Math.round(t.confidence * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {blastData.relatedModules.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Related Modules ({blastData.relatedModules.length})</p>
                    <div className="space-y-1">
                      {blastData.relatedModules.map((m, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] font-mono bg-secondary/20 rounded px-2 py-1">
                          <span className="truncate flex-1 text-muted-foreground/80">{m.path}</span>
                          <span className="text-muted-foreground/60 shrink-0">{Math.round(m.confidence * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {blastData.directDependents.length === 0 && blastData.affectedTests.length === 0 && blastData.relatedModules.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-3">No dependents found for this file.</p>
                )}
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

      {/* Symbol detail drawer */}
      <Sheet open={!!selectedSymbol} onOpenChange={(open) => { if (!open) setSelectedSymbol(null); }}>
        <SheetContent side="right" className="w-[420px] sm:w-[500px] overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2 font-mono text-base">
              {symbolDetail?.kind && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize bg-primary/5 border-primary/20 text-primary/80 font-sans">
                  {symbolDetail.kind}
                </Badge>
              )}
              <span className="truncate">{selectedSymbol?.name}</span>
            </SheetTitle>
          </SheetHeader>

          {symbolDetailLoading && (
            <div className="space-y-3 mt-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-5 w-3/4" />
            </div>
          )}

          {!symbolDetailLoading && symbolDetail && (
            <div className="space-y-5 mt-1">
              {/* Path */}
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Path</p>
                <p className="text-xs font-mono text-foreground/80 break-all">
                  {symbolDetail.path}{symbolDetail.line != null ? `:${symbolDetail.line}` : ""}
                </p>
              </div>

              {/* Signature */}
              {symbolDetail.signature && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Signature</p>
                  <pre className="text-xs font-mono bg-secondary/30 rounded p-2.5 whitespace-pre-wrap break-all text-foreground/90 border border-border/40">
                    {symbolDetail.signature}
                  </pre>
                </div>
              )}

              {/* Docstring */}
              {symbolDetail.docstring && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Docstring</p>
                  <p className="text-xs text-foreground/80 bg-secondary/20 rounded p-2.5 leading-relaxed whitespace-pre-wrap border border-border/40">
                    {symbolDetail.docstring}
                  </p>
                </div>
              )}

              {/* Callers */}
              {symbolDetail.callers.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                    Callers ({symbolDetail.callers.length})
                  </p>
                  <div className="space-y-1">
                    {symbolDetail.callers.map((caller, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] font-mono bg-secondary/20 rounded px-2 py-1.5 border border-border/30">
                        <span className="truncate text-foreground/80">{caller}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Callees */}
              {symbolDetail.callees.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                    Callees ({symbolDetail.callees.length})
                  </p>
                  <div className="space-y-1">
                    {symbolDetail.callees.map((callee, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] font-mono bg-secondary/20 rounded px-2 py-1.5 border border-border/30">
                        <span className="truncate text-foreground/80">{callee}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state for no extra data */}
              {!symbolDetail.signature && !symbolDetail.docstring && symbolDetail.callers.length === 0 && symbolDetail.callees.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No additional details available for this symbol.</p>
              )}
            </div>
          )}

          {!symbolDetailLoading && !symbolDetail && selectedSymbol && (
            <p className="text-sm text-muted-foreground mt-4 text-center">Symbol not found in the index.</p>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams();
  const sessionId = id ? parseInt(id, 10) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"overview" | "memory" | "smart-skills" | "repo" | "coordination" | "swarm">(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    const valid = ["overview", "memory", "smart-skills", "repo", "coordination", "team", "swarm"];
    const resolved = valid.includes(tab ?? "") ? tab : "overview";
    return (resolved === "team" ? "coordination" : resolved) as "overview" | "memory" | "smart-skills" | "repo" | "coordination" | "swarm";
  });
  const [newObsCount, setNewObsCount] = useState(0);
  const [badgePulseKey, setBadgePulseKey] = useState(0);
  const [seenConflictFingerprint, setSeenConflictFingerprint] = useState<string>("");
  const [conflictBadgePulseKey, setConflictBadgePulseKey] = useState(0);
  const prevConflictFingerprintRef = useRef<string>("");
  const [dismissedConflictFingerprint, setDismissedConflictFingerprint] = useState<string>(() =>
    sessionId ? (sessionStorage.getItem(`conflict-dismissed:${sessionId}`) ?? "") : ""
  );
  const [seenHandoffCount, setSeenHandoffCount] = useState(0);
  const toastedHandoffIdsRef = useRef<Set<number>>(new Set());
  const handoffDataInitializedRef = useRef(false);
  const acknowledgeHandoff = useAcknowledgeLaneHandoff();
  const [bootLog, setBootLog] = useState<string[]>([]);
  const lastBootMsgRef = useRef<string>("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Set<string>>(new Set());
  const [tunnelCopied, setTunnelCopied] = useState(false);

  // --- Live memory feed (lifted out of MemoryTab so it persists across tab switches) ---
  const [streamedObservations, setStreamedObservations] = useState<MemObservation[]>([]);
  const [memStreaming, setMemStreaming] = useState(false);
  const [memReconnecting, setMemReconnecting] = useState(false);
  const [memGaveUp, setMemGaveUp] = useState(false);
  const memEsRef = useRef<EventSource | null>(null);
  const memRetryCountRef = useRef(0);
  const memRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memConnectRef = useRef<(() => void) | null>(null);
  const memOnNewObsRef = useRef<(() => void) | undefined>(undefined);
  // Latches to true only after terminal status is confirmed for a full polling interval.
  const memSessionEndedRef = useRef(false);
  // Pending confirmation timer — fires once we've seen terminal status long enough.
  const memEndConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always-current mirror of session.status for use inside timer callbacks.
  const sessionStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setStreamedObservations([]);
    memRetryCountRef.current = 0;
    memSessionEndedRef.current = false;
    if (memEndConfirmTimerRef.current) {
      clearTimeout(memEndConfirmTimerRef.current);
      memEndConfirmTimerRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    function connect() {
      if (cancelled) return;

      const url = `${BASE_URL}api/sessions/${sessionId}/memory/stream`;
      const es = new EventSource(url);
      memEsRef.current = es;

      es.onopen = () => {
        if (cancelled) { es.close(); return; }
        memRetryCountRef.current = 0;
        setMemStreaming(true);
        setMemReconnecting(false);
        setMemGaveUp(false);
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const obs: MemObservation = JSON.parse(event.data);
          setStreamedObservations(prev => {
            if (prev.some(o => o.id === obs.id)) return prev;
            memOnNewObsRef.current?.();
            return [obs, ...prev];
          });
        } catch {
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        memEsRef.current = null;
        setMemStreaming(false);

        if (memSessionEndedRef.current) {
          setMemReconnecting(false);
          return;
        }

        if (memRetryCountRef.current >= MAX_RETRIES) {
          setMemReconnecting(false);
          setMemGaveUp(true);
          return;
        }

        const delay = RETRY_DELAYS[memRetryCountRef.current];
        memRetryCountRef.current += 1;
        setMemReconnecting(true);

        memRetryTimerRef.current = setTimeout(() => {
          if (!cancelled && !memSessionEndedRef.current) connect();
        }, delay);
      };
    }

    memConnectRef.current = connect;
    connect();

    return () => {
      cancelled = true;
      if (memRetryTimerRef.current) {
        clearTimeout(memRetryTimerRef.current);
        memRetryTimerRef.current = null;
      }
      if (memEsRef.current) {
        memEsRef.current.close();
        memEsRef.current = null;
      }
      setMemStreaming(false);
      setMemReconnecting(false);
      setMemGaveUp(false);
      memRetryCountRef.current = 0;
    };
  }, [sessionId]);

  const handleMemoryReconnect = () => {
    if (memRetryTimerRef.current) {
      clearTimeout(memRetryTimerRef.current);
      memRetryTimerRef.current = null;
    }
    if (memEsRef.current) {
      memEsRef.current.close();
      memEsRef.current = null;
    }
    memRetryCountRef.current = 0;
    setMemGaveUp(false);
    setMemReconnecting(false);
    memConnectRef.current?.();
  };
  // --- end live memory feed ---

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
        return s === "ready" || s === "stopped" || s === "error" ? false : SESSION_POLL_MS;
      },
    }
  });

  const deleteSession = useDeleteSession();
  const refreshStatus = useRefreshSessionStatus();
  const createSession = useCreateSession();
  const updateSession = useUpdateSession();
  // Profiles power the "Usually ~N min" hint in the BootTimeline footer.
  const { data: profiles } = useListProfiles();
  const [isRetrying, setIsRetrying] = useState(false);
  const [stopRatingOpen, setStopRatingOpen] = useState(false);
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const completeFeedback = useSessionCompleteFeedback();

  // Two-phase SSE shutdown: close the feed only after the session status has been
  // observed as terminal (stopped/errored) for at least one full polling interval.
  // This prevents a single transient status flip from permanently killing the stream.
  //
  // Phase 1 — terminal first seen: start a confirmation timer (> polling interval).
  // Phase 2 — timer fires: if status is still terminal, latch and close the SSE.
  // Cancel  — if status returns non-terminal before the timer fires: cancel timer,
  //           unlatch the ref (reconnects remain allowed).
  //
  // MEM_FEED_CONFIRM_MS is intentionally > SESSION_POLL_MS so a genuine transition
  // always survives at least one extra poll before the stream is closed.
  const sessionStatus = session?.status;
  // Keep sessionStatusRef in sync so the async timer callback reads current value.
  sessionStatusRef.current = sessionStatus;

  useEffect(() => {
    const isTerminal = sessionStatus === "stopped" || sessionStatus === "error";

    if (!isTerminal) {
      // Status no longer terminal — cancel any pending confirmation and unlatch.
      if (memEndConfirmTimerRef.current) {
        clearTimeout(memEndConfirmTimerRef.current);
        memEndConfirmTimerRef.current = null;
      }
      memSessionEndedRef.current = false;
      return;
    }

    // Already confirmed ended or confirmation already in flight — nothing to do.
    if (memSessionEndedRef.current || memEndConfirmTimerRef.current) return;

    // Start the confirmation window.
    memEndConfirmTimerRef.current = setTimeout(() => {
      memEndConfirmTimerRef.current = null;
      const stillTerminal =
        sessionStatusRef.current === "stopped" || sessionStatusRef.current === "error";
      if (!stillTerminal) return;

      // Confirmed — latch and tear down cleanly.
      memSessionEndedRef.current = true;
      if (memRetryTimerRef.current) {
        clearTimeout(memRetryTimerRef.current);
        memRetryTimerRef.current = null;
      }
      if (memEsRef.current) {
        memEsRef.current.close();
        memEsRef.current = null;
      }
      setMemStreaming(false);
      setMemReconnecting(false);
    }, MEM_FEED_CONFIRM_MS);

    return () => {
      if (memEndConfirmTimerRef.current) {
        clearTimeout(memEndConfirmTimerRef.current);
        memEndConfirmTimerRef.current = null;
      }
    };
  }, [sessionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swarm status — polled every 3 seconds when session is ready
  // Must be called unconditionally before early returns (rules of hooks)
  const sessionIsReady = session?.status === "ready";
  const { data: swarmData } = useSwarmStatus(sessionId, sessionIsReady);

  // Fetch routing stats in the background so they are ready when the session stops.
  // bytesAvoided is passed to complete-feedback to signal context-shield-core effectiveness.
  const { data: routingStatsData } = useGetSessionRoutingStats(sessionId);
  const bytesAvoided = routingStatsData?.stats?.totalBytesAvoided;

  // Background conflict polling for the Coordination tab badge
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
    if (activeTab === "coordination" && hasAnyConflict) {
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

  // Note: swarm/handoff/conflict notifications are emitted globally by
  // the per-session watchers in `notification-watchers.tsx` so they fire
  // regardless of which page the user is currently viewing.

  // When the Coordination tab is opened, mark current pending handoffs as seen.
  // When handoffs are all resolved (count hits 0), reset seen count too.
  useEffect(() => {
    if (activeTab === "coordination") {
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
    toastedHandoffIdsRef.current = new Set();
    handoffDataInitializedRef.current = false;
  }, [sessionId]);

  // Fire a toast when new pending handoffs arrive and the Coordination tab is not active.
  // On first data load, we seed the seen-set without toasting (avoid false positives
  // for handoffs that were already pending before the user opened this session page).
  useEffect(() => {
    const handoffs = bgCoordData?.recentHandoffs ?? [];
    if (!handoffDataInitializedRef.current) {
      handoffs.forEach((h) => toastedHandoffIdsRef.current.add(h.id));
      handoffDataInitializedRef.current = true;
      return;
    }
    const newHandoffs = handoffs.filter(
      (h) => h.status === "pending" && !toastedHandoffIdsRef.current.has(h.id)
    );
    if (newHandoffs.length === 0) return;
    newHandoffs.forEach((h) => toastedHandoffIdsRef.current.add(h.id));
    if (activeTab === "coordination") return;
    const typeLabels: Record<string, string> = {
      blocked: "Blocked",
      needs_review: "Needs Review",
      safe_to_merge: "Safe to Merge",
      watch_files: "Watch Files",
      related_lane: "Related Lane",
    };
    const ackHandoffs = (handoffs: typeof newHandoffs) => {
      handoffs.forEach((h) =>
        acknowledgeHandoff.mutate(
          { id: sessionId, laneId: h.fromLaneId, handoffId: h.id, data: { status: "acknowledged" } },
          { onSettled: () => queryClient.invalidateQueries({ queryKey: getGetSessionCoordinationQueryKey(sessionId) }) },
        )
      );
    };
    if (newHandoffs.length === 1) {
      const h = newHandoffs[0];
      const label = typeLabels[h.handoffType] ?? h.handoffType;
      let viewClicked = false;
      toast({
        title: `Handoff: ${label}`,
        description: h.message ?? "A teammate sent a handoff signal.",
        onOpenChange: (open) => {
          if (!open && !viewClicked) ackHandoffs([h]);
        },
        action: (
          <ToastAction altText="Open Coordination tab" onClick={() => {
            viewClicked = true;
            setActiveTab("coordination");
            ackHandoffs([h]);
          }}>
            View
          </ToastAction>
        ),
      });
    } else {
      let viewClicked = false;
      toast({
        title: `${newHandoffs.length} new handoff signals`,
        description: newHandoffs
          .map((h) => typeLabels[h.handoffType] ?? h.handoffType)
          .join(", "),
        onOpenChange: (open) => {
          if (!open && !viewClicked) ackHandoffs(newHandoffs);
        },
        action: (
          <ToastAction altText="Open Coordination tab" onClick={() => {
            viewClicked = true;
            setActiveTab("coordination");
            ackHandoffs(newHandoffs);
          }}>
            View
          </ToastAction>
        ),
      });
    }
  }, [bgCoordData?.recentHandoffs, activeTab, toast]);

  const pendingHandoffBadgeCount = bgPendingHandoffs > seenHandoffCount
    ? bgPendingHandoffs - seenHandoffCount
    : 0;
  const showHandoffBadge = pendingHandoffBadgeCount > 0 && activeTab !== "coordination";

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

  // Top-level re-index handler — used both by the cockpit "r" shortcut and the
  // command palette. Mirrors the per-tab handler in RepoIndexTab but lives here
  // so it's available even when the user is on a different tab.
  const reindexFromShortcut = useEnqueueRepoIndex();
  const handleReindexShortcut = () => {
    reindexFromShortcut.mutate(
      { sessionId, data: {} },
      {
        onSuccess: () => {
          toast({ title: "Re-index triggered", description: "Indexing job enqueued — this may take a few minutes." });
          queryClient.invalidateQueries({ queryKey: getGetRepoSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetRepoFingerprintQueryKey(sessionId) });
        },
        onError: () => toast({ title: "Failed to trigger re-index", variant: "destructive" }),
      },
    );
  };

  // Listen for "stop session" requests from the command palette so the
  // palette's "Stop Session" command goes through the same feedback dialog.
  useEffect(() => {
    const onStopRequest = () => {
      const sess = session;
      if (!sess) return;
      if (sess.status === "stopped" || sess.status === "error") return;
      handleStop();
    };
    window.addEventListener("floatr:request-stop-session", onStopRequest);
    return () => window.removeEventListener("floatr:request-stop-session", onStopRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Cockpit keyboard shortcuts: 1–6 switch tabs, r triggers repo re-index,
  // s opens the stop/feedback dialog. Disabled while typing in inputs/textareas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when modifier keys are held (Cmd+K etc. are owned by the palette).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e)) return;

      const sess = session;
      if (!sess) return;

      // Tab visibility — must match the JSX render conditions.
      const teamMembers = (sess.teamMembers ?? []) as Array<{ name: string }>;
      const hasTeam = teamMembers.some((m) => m.name !== "__shared__");
      const isReadyNow = sess.status === "ready";
      const showSwarm = isReadyNow || swarmTabShouldShow(swarmData);
      const isSessActive = sess.status !== "stopped" && sess.status !== "error";

      switch (e.key) {
        case "1":
          e.preventDefault();
          setActiveTab("overview");
          break;
        case "2":
          e.preventDefault();
          setActiveTab("memory");
          setNewObsCount(0);
          setBadgePulseKey(0);
          break;
        case "3":
          e.preventDefault();
          setActiveTab("smart-skills");
          break;
        case "4":
          e.preventDefault();
          setActiveTab("repo");
          break;
        case "5":
          if (hasTeam) {
            e.preventDefault();
            setActiveTab("coordination");
          }
          break;
        case "6":
          if (showSwarm) {
            e.preventDefault();
            setActiveTab("swarm");
          }
          break;
        case "r":
          e.preventDefault();
          handleReindexShortcut();
          break;
        case "s":
          if (isSessActive) {
            e.preventDefault();
            handleStop();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, swarmData]);

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
        createSession.mutate({ data: { profileId: session.profileId, intentText: session.intentText ?? null } }, {
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
  // Boot timeline derivation — phases are inferred from the (status, statusMessage)
  // pair plus the accumulated bootLog. The compact progress strip is rendered
  // below the tab bar while the session is still booting; it disappears once
  // status reaches ready/stopped/error.
  const isBooting = ["pending", "provisioning", "downloading", "starting"].includes(session.status);
  const bootPhases = useMemo(
    () => inferBootPhase({
      status: session.status,
      statusMessage: session.statusMessage,
      bootLog,
    }),
    [session.status, session.statusMessage, bootLog],
  );
  const profileStartupMin = profiles?.find(p => p.id === session.profileId)?.startupTimeMin ?? null;
  const sessionStartedAt = session.startedAt
    ? new Date(session.startedAt)
    : (session.createdAt ? new Date(session.createdAt) : null);

  // Keep the new-observation badge callback in sync without causing re-renders.
  // Only fire it when the Memory tab is not currently visible.
  memOnNewObsRef.current = activeTab !== "memory" ? () => setNewObsCount(prev => {
    if (prev > 0) setBadgePulseKey(k => k + 1);
    return prev + 1;
  }) : undefined;

  const swarmBadge = swarmTabBadgeLabel(swarmData);
  const swarmIsLive = swarmTabIsActive(swarmData);
  // Show the Swarm tab if the session is ready (active) — so users can see when swarm starts —
  // or if there is actual swarm data to display (historical runs for stopped sessions).
  const showSwarmTab = isReady || swarmTabShouldShow(swarmData);

  // Determine if the current user is the session "owner" for swarm abort gating.
  // The abort button is only shown to session owners, hidden for non-owner team members.
  //
  // Identity model:
  //   • Solo sessions (no named teamMembers): dashboard viewer is always the operator → owner.
  //   • Team sessions (has named members): without a login layer we cannot distinguish the
  //     owner from a team member who might access this URL. We take the conservative stance
  //     and hide the abort button for all team sessions to prevent accidental use by non-owners.
  //     The operator of a team session can still call the abort API directly with ownerToken.
  //
  // Server enforcement: abort endpoint always validates ownerToken regardless of this UI check,
  // providing a defence-in-depth layer independent of what the UI shows.
  const sessionTeamMembers = (session.teamMembers ?? []) as Array<{ name: string }>;
  const hasNamedTeamMembers = sessionTeamMembers.some((m) => m.name !== "__shared__");
  const isSessionOwner = !hasNamedTeamMembers;

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
          {/* Session goal — compact badge, only shown when set. Truncated to
              80 chars with hover tooltip showing the full text. Click to edit
              inline via popover. */}
          {session.intentText ? (
            (() => {
              const fullGoal = session.intentText;
              const TRUNCATE = 80;
              const display = fullGoal.length > TRUNCATE
                ? `${fullGoal.slice(0, TRUNCATE).trimEnd()}…`
                : fullGoal;
              return (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Popover
                        open={goalEditOpen}
                        onOpenChange={(open) => {
                          if (open) setGoalDraft(fullGoal);
                          setGoalEditOpen(open);
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="mt-2 inline-flex items-center gap-1.5 max-w-xl text-left rounded-md border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-colors px-2 py-1 group"
                            data-testid="button-edit-session-goal"
                          >
                            <Target className="w-3 h-3 text-primary shrink-0" />
                            <span className="text-[11px] leading-tight text-foreground/90 truncate">{display}</span>
                            <Pencil className="w-2.5 h-2.5 text-muted-foreground/60 group-hover:text-foreground shrink-0" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80 space-y-2" align="start">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session goal</p>
                          <Textarea
                            value={goalDraft}
                            onChange={e => setGoalDraft(e.target.value.slice(0, 500))}
                            rows={4}
                            placeholder="e.g. Add Stripe checkout to the billing page"
                            className="text-sm resize-none"
                            data-testid="textarea-session-goal"
                            autoFocus
                          />
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-muted-foreground/60">{goalDraft.length}/500</span>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setGoalEditOpen(false)} disabled={updateSession.isPending}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => {
                                  const next = goalDraft.trim();
                                  updateSession.mutate(
                                    { sessionId, data: { intentText: next.length > 0 ? next : null } },
                                    {
                                      onSuccess: () => {
                                        toast({ title: "Session goal updated" });
                                        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
                                        setGoalEditOpen(false);
                                      },
                                      onError: () => toast({ title: "Failed to update goal", variant: "destructive" }),
                                    },
                                  );
                                }}
                                disabled={updateSession.isPending}
                                data-testid="button-save-session-goal"
                              >
                                {updateSession.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </TooltipTrigger>
                    {fullGoal.length > TRUNCATE && (
                      <TooltipContent side="bottom" className="max-w-md text-xs">
                        {fullGoal}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              );
            })()
          ) : null}
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
          {session.status === "stopped" && (
            <RelaunchButton sessionId={session.id} variant="prominent" />
          )}
        </div>
      </div>

      {/* Compact progress strip below header — visible across all tabs while booting. */}
      {isBooting && <BootProgressStrip phases={bootPhases} />}

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
          Repo Intelligence
        </button>
        {hasNamedTeamMembers && (
          <button
            onClick={() => { setActiveTab("coordination"); setSeenConflictFingerprint(conflictFingerprint); setSeenHandoffCount(bgPendingHandoffs); }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              activeTab === "coordination"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Coordination
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
        )}
        {showSwarmTab && (
          <button
            onClick={() => setActiveTab("swarm")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              activeTab === "swarm"
                ? "border-primary text-foreground"
                : swarmIsLive
                  ? "border-transparent text-primary hover:text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Network className={`w-3.5 h-3.5 ${swarmIsLive ? "animate-pulse" : ""}`} />
            Swarm
            {swarmBadge && (
              <span className={`ml-0.5 px-1.5 py-0 flex items-center justify-center rounded-full text-[10px] font-semibold leading-none ${
                swarmIsLive
                  ? "bg-primary text-primary-foreground animate-badge-pop"
                  : "bg-secondary text-secondary-foreground"
              }`}>
                {swarmBadge}
              </span>
            )}
          </button>
        )}
      </div>

      {activeTab === "overview" && (
        <>
          {/* Boot Timeline — replaces the legacy raw-status block. Shown while
              booting OR if the session ended before reaching ready, so users
              can see where it stopped. */}
          {(isBooting || (!isReady && bootLog.length > 0)) && (
            <BootTimeline
              phases={bootPhases}
              startedAt={sessionStartedAt}
              estimateMinutes={profileStartupMin}
              rawStatusMessage={session.statusMessage}
              bootLog={bootLog}
              diskFullAction={{ onRetry: handleDestroyAndRetry, isRetrying }}
            />
          )}

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
                  onClick={() => { setActiveTab("coordination"); setSeenConflictFingerprint(conflictFingerprint); }}
                >
                  View in Coordination tab
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
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">GPU</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{session.gpuName || "—"} x{session.numGpus || "—"}</span>
                    {(() => {
                      const swarmCap = session.swarmWorkerCap ?? 0;
                      if (swarmCap <= 0) return null;
                      const isLimited = swarmCap <= 8;
                      return (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border font-medium cursor-default ${
                                isLimited
                                  ? "border-yellow-500/50 text-yellow-500 bg-yellow-500/5"
                                  : "border-primary/50 text-primary bg-primary/5"
                              }`}>
                                {isLimited
                                  ? <AlertTriangle className="w-2.5 h-2.5" />
                                  : <Network className="w-2.5 h-2.5" />
                                }
                                {isLimited ? "Limited swarm" : "Swarm-ready"}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs text-xs">
                              {isLimited
                                ? `Limited swarm: up to ${swarmCap} workers — use a higher tier for swarm tasks`
                                : `Swarm-ready: up to ${swarmCap} workers`
                              }
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}
                  </div>
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
          streaming={memStreaming}
          reconnecting={memReconnecting}
          gaveUp={memGaveUp}
          streamedObservations={streamedObservations}
          onReconnect={handleMemoryReconnect}
        />
      </div>

      {activeTab === "smart-skills" && (
        <SmartSkillsTab sessionId={sessionId} taskMode={session.taskMode ?? null} />
      )}

      {activeTab === "repo" && (
        <RepoIndexTab sessionId={sessionId} />
      )}

      {activeTab === "coordination" && hasNamedTeamMembers && (
        <TeamTab sessionId={sessionId} />
      )}

      {activeTab === "swarm" && (
        <SwarmActivityPanel
          sessionId={sessionId}
          isReady={isReady}
          isSessionOwner={isSessionOwner}
          ownerToken={session.ownerToken}
        />
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
