import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useListSessions, useGetBatchRepoStatus, getGetBatchRepoStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Terminal, Eye, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SwarmPill } from "@/components/swarm-activity-panel";
import type { SwarmStatusResponse } from "@/components/swarm-activity-panel";
import { Badge } from "@/components/ui/badge";
import { RelaunchButton } from "@/components/relaunch-button";
import { isTypingTarget } from "@/lib/shortcuts";
import { useVisibilityReconnect } from "@/hooks/use-visibility-reconnect";

const RELAUNCHABLE_STATUSES = new Set(["stopped"]);

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const BATCH_INTERVAL_MS = 3000;
// When SSE is unavailable we fall back to polling, but at a much lower
// frequency than the SSE update rate — there is no point hammering the
// endpoint when no sessions are actively running.
const IDLE_POLL_INTERVAL_MS = 30_000;

async function fetchBatchStatus(idsKey: string): Promise<Record<number, SwarmStatusResponse>> {
  const res = await fetch(`${BASE_URL}api/sessions/swarm-status-batch?ids=${idsKey}`);
  if (!res.ok) throw new Error("batch fetch failed");
  const json: Record<string, SwarmStatusResponse> = await res.json();
  const coerced: Record<number, SwarmStatusResponse> = {};
  for (const [k, v] of Object.entries(json)) coerced[Number(k)] = v;
  return coerced;
}

function useSwarmBatchSse(sessionIds: number[], readySessionIds: number[], initialData?: Record<number, SwarmStatusResponse>) {
  const [statusMap, setStatusMap] = useState<Record<number, SwarmStatusResponse>>({});
  const allIdsKey = sessionIds.slice().sort((a, b) => a - b).join(",");
  const readyIdsKey = readySessionIds.slice().sort((a, b) => a - b).join(",");
  // Incrementing this forces the SSE effect to tear down and reconnect on tab focus.
  const [reconnectKey, setReconnectKey] = useState(0);

  // Seed the status map with inline data from the sessions list as soon as it arrives,
  // but only once per unique dataset (tracked by allIdsKey). This gives pills an
  // initial value on the very first paint before the batch fetch round-trip completes.
  const seededKeyRef = useRef<string>("");
  useEffect(() => {
    if (!initialData || Object.keys(initialData).length === 0) return;
    if (seededKeyRef.current === allIdsKey) return;
    seededKeyRef.current = allIdsKey;
    setStatusMap((prev) => ({ ...initialData, ...prev }));
  }, [initialData, allIdsKey]);

  // Keep a mutable ref so fallback callbacks always use the freshest allIdsKey
  // even when the SSE effect hasn't re-run yet.
  const allIdsKeyRef = useRef(allIdsKey);
  useEffect(() => { allIdsKeyRef.current = allIdsKey; }, [allIdsKey]);

  // Reconnect all streams when the tab regains focus to avoid silent stalls.
  useVisibilityReconnect(() => setReconnectKey((k) => k + 1));

  // Initial batch fetch — populates historical data for all sessions including stopped ones.
  useEffect(() => {
    if (sessionIds.length === 0) {
      setStatusMap({});
      return;
    }
    fetchBatchStatus(allIdsKey)
      .then((data) => setStatusMap(data))
      .catch(() => {});
  }, [allIdsKey]);

  // SSE streams for ready sessions; degrade to batch polling on any stream error.
  useEffect(() => {
    if (readySessionIds.length === 0) return;

    const streams: EventSource[] = [];
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    // Track per-session SSE health so we can stop polling once all streams recover.
    const sseHealthy = new Set<number>();

    // Start batch polling as a fallback — called on the first SSE error so no
    // pill goes stale while EventSource is reconnecting.  We intentionally use
    // the longer idle interval here: SSE is the primary real-time channel, so
    // the fallback only needs to keep data roughly fresh, not match the SSE
    // cadence.  If there are no ready sessions the effect returns early (above)
    // so this function is never reached in that case.
    const startPollingFallback = () => {
      if (fallbackInterval) return;
      const doFetch = () => {
        const key = allIdsKeyRef.current;
        // Extra guard: skip the network call when there are no active sessions.
        if (!key || readySessionIds.length === 0) return;
        fetchBatchStatus(key)
          .then((data) => setStatusMap((prev) => ({ ...prev, ...data })))
          .catch(() => {});
      };
      doFetch();
      fallbackInterval = setInterval(doFetch, IDLE_POLL_INTERVAL_MS);
    };

    // Stop polling once every ready session has a healthy SSE stream again.
    const maybeStopPollingFallback = () => {
      if (!fallbackInterval) return;
      if (sseHealthy.size >= readySessionIds.length) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    };

    for (const id of readySessionIds) {
      try {
        const es = new EventSource(`${BASE_URL}api/sessions/${id}/swarm-stream`);
        streams.push(es);

        es.onmessage = (event) => {
          try {
            const json: SwarmStatusResponse = JSON.parse(event.data);
            setStatusMap((prev) => ({ ...prev, [id]: json }));
            // Stream is delivering data — mark healthy and cancel polling if all recovered.
            sseHealthy.add(id);
            maybeStopPollingFallback();
          } catch {
            // Ignore malformed events
          }
        };

        es.onerror = () => {
          // Do NOT close — let EventSource reconnect automatically.
          // Start polling immediately so the pill doesn't go stale during reconnect.
          sseHealthy.delete(id);
          startPollingFallback();
        };
      } catch {
        // EventSource constructor failed — start polling right away.
        startPollingFallback();
      }
    }

    return () => {
      for (const es of streams) es.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [readyIdsKey, reconnectKey]); // allIdsKey tracked via ref so fallback always uses current IDs

  return statusMap;
}

type TeamFilter = "all" | "team" | "solo";
type StatusFilter = "all" | "active" | "stopped" | "error";

const ACTIVE_STATUSES = new Set(["pending", "provisioning", "downloading", "starting", "ready", "stopping"]);

const TERMINAL_REPO_STATUSES = new Set(["ready", "error"]);

const REPO_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  scanning: "Scanning",
  fingerprinting: "Fingerprinting",
  indexing_graph: "Indexing",
  indexing_fts: "Indexing",
  indexing_vectors: "Indexing",
  summarizing: "Summarizing",
  ready: "Indexed",
  error: "Error",
};

const REPO_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ready: "default",
  error: "destructive",
};

function RepoStatusBadge({ indexStatus, isStale }: { indexStatus: string; isStale: boolean }) {
  const label = REPO_STATUS_LABELS[indexStatus] ?? indexStatus;
  const variant = REPO_STATUS_VARIANT[indexStatus] ?? "secondary";
  return (
    <Badge variant={variant} className="text-xs font-mono">
      {label}{isStale ? " (stale)" : ""}
    </Badge>
  );
}

const VALID_TEAM_FILTERS = new Set<TeamFilter>(["all", "team", "solo"]);
const LS_TEAM_FILTER_KEY = "sessions:teamFilter";

function readStoredTeamFilter(): TeamFilter {
  try {
    const stored = localStorage.getItem(LS_TEAM_FILTER_KEY);
    if (stored && VALID_TEAM_FILTERS.has(stored as TeamFilter)) return stored as TeamFilter;
  } catch {}
  return "all";
}

function writeStoredTeamFilter(value: TeamFilter) {
  try {
    if (value === "all") {
      localStorage.removeItem(LS_TEAM_FILTER_KEY);
    } else {
      localStorage.setItem(LS_TEAM_FILTER_KEY, value);
    }
  } catch {}
}

function getTeamFilterFromSearch(search: string): TeamFilter | null {
  const params = new URLSearchParams(search);
  const raw = params.get("filter");
  return raw && VALID_TEAM_FILTERS.has(raw as TeamFilter) ? (raw as TeamFilter) : null;
}

const VALID_STATUS_FILTERS = new Set<StatusFilter>(["all", "active", "stopped", "error"]);
const LS_STATUS_FILTER_KEY = "sessions:statusFilter";

function readStoredStatusFilter(): StatusFilter {
  try {
    const stored = localStorage.getItem(LS_STATUS_FILTER_KEY);
    if (stored && VALID_STATUS_FILTERS.has(stored as StatusFilter)) return stored as StatusFilter;
  } catch {}
  return "all";
}

function writeStoredStatusFilter(value: StatusFilter) {
  try {
    if (value === "all") {
      localStorage.removeItem(LS_STATUS_FILTER_KEY);
    } else {
      localStorage.setItem(LS_STATUS_FILTER_KEY, value);
    }
  } catch {}
}

function getStatusFilterFromSearch(search: string): StatusFilter | null {
  const params = new URLSearchParams(search);
  const raw = params.get("status");
  return raw && VALID_STATUS_FILTERS.has(raw as StatusFilter) ? (raw as StatusFilter) : null;
}

export default function SessionsList() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { data: sessions, isLoading } = useListSessions();
  const queryClient = useQueryClient();
  const [indexingIds, setIndexingIds] = useState<Set<number>>(new Set());

  const urlTeamFilter = getTeamFilterFromSearch(search);
  const teamFilter: TeamFilter = urlTeamFilter ?? readStoredTeamFilter();

  const urlStatusFilter = getStatusFilterFromSearch(search);
  const statusFilter: StatusFilter = urlStatusFilter ?? readStoredStatusFilter();

  // Sync URL-derived filters into localStorage so that returning via bare /sessions
  // (e.g. sidebar navigation) always restores the last viewed filters, including
  // those set by opening a shared link.
  useEffect(() => {
    if (urlTeamFilter !== null) writeStoredTeamFilter(urlTeamFilter);
  }, [urlTeamFilter]);

  useEffect(() => {
    if (urlStatusFilter !== null) writeStoredStatusFilter(urlStatusFilter);
  }, [urlStatusFilter]);

  const setTeamFilter = (value: TeamFilter) => {
    writeStoredTeamFilter(value);
    const params = new URLSearchParams(search);
    if (value === "all") {
      params.delete("filter");
    } else {
      params.set("filter", value);
    }
    const qs = params.toString();
    const basePath = location.split("?")[0];
    setLocation(basePath + (qs ? `?${qs}` : ""));
  };

  const setStatusFilter = (value: StatusFilter) => {
    writeStoredStatusFilter(value);
    const params = new URLSearchParams(search);
    if (value === "all") {
      params.delete("status");
    } else {
      params.set("status", value);
    }
    const qs = params.toString();
    const basePath = location.split("?")[0];
    setLocation(basePath + (qs ? `?${qs}` : ""));
  };

  const filteredSessions = sessions?.filter((session) => {
    if (teamFilter === "team" && !(session.teamMembers && session.teamMembers.length > 0)) return false;
    if (teamFilter === "solo" && !(!session.teamMembers || session.teamMembers.length === 0)) return false;
    if (statusFilter === "active" && !ACTIVE_STATUSES.has(session.status)) return false;
    if (statusFilter === "stopped" && session.status !== "stopped") return false;
    if (statusFilter === "error" && session.status !== "error") return false;
    return true;
  });

  const sessionIds = useMemo(() => sessions?.map(s => s.id) ?? [], [sessions]);
  const readySessionIds = useMemo(() => sessions?.filter(s => s.status === "ready").map(s => s.id) ?? [], [sessions]);

  // Build the initial swarm status map from inline data returned by the sessions list endpoint.
  // This means pills can render on the very first paint with no extra round-trip.
  const inlineSwarmData = useMemo<Record<number, SwarmStatusResponse>>(() => {
    if (!sessions) return {};
    const map: Record<number, SwarmStatusResponse> = {};
    for (const s of sessions) {
      const sw = (s as typeof s & { swarmStatus?: SwarmStatusResponse | null }).swarmStatus;
      if (sw) map[s.id] = sw;
    }
    return map;
  }, [sessions]);

  const swarmStatusMap = useSwarmBatchSse(sessionIds, readySessionIds, inlineSwarmData);

  const idsParam = useMemo(
    () => sessionIds.length > 0 ? sessionIds.join(",") : undefined,
    [sessionIds]
  );

  const { data: repoStatuses } = useGetBatchRepoStatus(
    { ids: idsParam! },
    {
      query: {
        enabled: !!idsParam,
        queryKey: getGetBatchRepoStatusQueryKey(idsParam ? { ids: idsParam } : undefined),
        refetchInterval: (query) => {
          const statuses = Object.values(
            (query.state.data as { statuses?: Record<string, { indexStatus: string }> } | undefined)?.statuses ?? {}
          );
          return statuses.some((s) => !TERMINAL_REPO_STATUSES.has(s.indexStatus)) ? 10_000 : false;
        },
      },
    }
  );

  const repoStatusMap = repoStatuses?.statuses ?? {};

  async function handleStartIndexing(sessionId: number) {
    setIndexingIds((prev) => new Set(prev).add(sessionId));
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/repo/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const batchKey = getGetBatchRepoStatusQueryKey(idsParam ? { ids: idsParam } : undefined);
        queryClient.setQueryData(batchKey, (old: { statuses: Record<number, { indexStatus: string; isStale: boolean; confidenceLevel: string }> } | undefined) => ({
          statuses: {
            ...(old?.statuses ?? {}),
            [sessionId]: { indexStatus: "queued", isStale: false, confidenceLevel: "none" },
          },
        }));
      }
    } finally {
      setIndexingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  // Keyboard navigation: j/k move focus, Enter opens, n creates new.
  // focusedIndex is bounded by the visible (filtered) row list.
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const visibleCount = filteredSessions?.length ?? 0;

  // Reset focus when filter changes or rows disappear.
  useEffect(() => {
    if (focusedIndex >= visibleCount) setFocusedIndex(visibleCount > 0 ? 0 : -1);
  }, [visibleCount, focusedIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dispatchNewSession = () => {
        if (window.location.pathname.replace(/\/$/, "") !== "") {
          setLocation("/");
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("floatr:open-launch-dialog"));
          }, 50);
        } else {
          window.dispatchEvent(new CustomEvent("floatr:open-launch-dialog"));
        }
      };
      if (!filteredSessions || filteredSessions.length === 0) {
        if (e.key === "n") {
          e.preventDefault();
          dispatchNewSession();
        }
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const next = i < 0 ? 0 : Math.min(i + 1, filteredSessions.length - 1);
          return next;
        });
      } else if (e.key === "k") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const next = i < 0 ? 0 : Math.max(i - 1, 0);
          return next;
        });
      } else if (e.key === "Enter") {
        if (focusedIndex >= 0 && focusedIndex < filteredSessions.length) {
          e.preventDefault();
          setLocation(`/sessions/${filteredSessions[focusedIndex].id}`);
        }
      } else if (e.key === "n") {
        e.preventDefault();
        dispatchNewSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredSessions, focusedIndex, setLocation]);

  // Scroll focused row into view when it changes.
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
          <p className="text-muted-foreground mt-1">History of all active and past coding sessions</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-border/50 overflow-hidden bg-card/50 text-sm">
            {(["all", "active", "stopped", "error"] as StatusFilter[]).map((option) => (
              <button
                key={option}
                onClick={() => setStatusFilter(option)}
                className={`px-3 py-1.5 capitalize transition-colors ${
                  statusFilter === option
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-lg border border-border/50 overflow-hidden bg-card/50 text-sm">
            {(["all", "team", "solo"] as TeamFilter[]).map((option) => (
              <button
                key={option}
                onClick={() => setTeamFilter(option)}
                className={`px-3 py-1.5 capitalize transition-colors ${
                  teamFilter === option
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <Button onClick={() => setLocation("/")} className="gap-2">
            <Plus className="w-4 h-4" /> New Session
          </Button>
        </div>
      </div>

      <div className="border border-border/50 rounded-lg bg-card/50 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50 bg-secondary/20">
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Repo Index</TableHead>
              <TableHead>Hardware</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-8 w-8 ml-auto rounded" /></TableCell>
                </TableRow>
              ))
            ) : filteredSessions?.length ? (
              filteredSessions.map((session, idx) => {
                const repoStatus = repoStatusMap[session.id];
                const isFocused = idx === focusedIndex;
                return (
                  <TableRow
                    key={session.id}
                    ref={isFocused ? focusedRowRef : undefined}
                    data-focused={isFocused ? "true" : undefined}
                    className={`border-border/50 ${isFocused ? "bg-primary/10 outline outline-1 outline-primary/40" : ""}`}
                  >
                    <TableCell className="font-mono text-muted-foreground">#{session.id}</TableCell>
                    <TableCell className="font-medium">{session.profileName}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <SessionStatusBadge status={session.status} />
                        {session.teamMembers && session.teamMembers.length > 0 && <TeamSessionBadge members={session.teamMembers} />}
                        <SwarmPill
                          sessionId={session.id}
                          isReady={session.status === "ready"}
                          data={swarmStatusMap[session.id] ?? null}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      {repoStatus ? (
                        <button
                          onClick={() => setLocation(`/sessions/${session.id}?tab=repo`)}
                          className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                        >
                          <RepoStatusBadge
                            indexStatus={repoStatus.indexStatus}
                            isStale={repoStatus.isStale}
                          />
                        </button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs gap-1"
                          disabled={indexingIds.has(session.id)}
                          onClick={(e) => { e.stopPropagation(); handleStartIndexing(session.id); }}
                          title="Start indexing this session's repo"
                        >
                          <RefreshCw className={`w-3 h-3 ${indexingIds.has(session.id) ? "animate-spin" : ""}`} />
                          Index
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {session.gpuName ? `${session.gpuName} x${session.numGpus}` : 'N/A'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(session.createdAt), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      ${session.totalCost?.toFixed(2) || "0.00"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {RELAUNCHABLE_STATUSES.has(session.status) && (
                          <RelaunchButton sessionId={session.id} variant="icon" />
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setLocation(`/sessions/${session.id}`)}
                          title="View Details"
                        >
                          <Eye className="w-4 h-4 text-primary" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  {teamFilter === "all" && statusFilter === "all"
                    ? "No sessions found"
                    : `No ${statusFilter === "all" ? "" : statusFilter + " "}${teamFilter === "all" ? "" : teamFilter + " "}sessions found`.replace(/\s+/g, " ").trim()}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
