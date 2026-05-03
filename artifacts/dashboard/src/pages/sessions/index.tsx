import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useListSessions, useGetBatchRepoStatus, getGetBatchRepoStatusQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Terminal, Eye, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SwarmPill } from "@/components/swarm-activity-panel";
import type { SwarmStatusResponse } from "@/components/swarm-activity-panel";
import { Badge } from "@/components/ui/badge";
import { RelaunchButton } from "@/components/relaunch-button";
import { isTypingTarget } from "@/lib/shortcuts";

const RELAUNCHABLE_STATUSES = new Set(["stopped"]);

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const BATCH_INTERVAL_MS = 3000;

async function fetchBatchStatus(idsKey: string): Promise<Record<number, SwarmStatusResponse>> {
  const res = await fetch(`${BASE_URL}api/sessions/swarm-status-batch?ids=${idsKey}`);
  if (!res.ok) throw new Error("batch fetch failed");
  const json: Record<string, SwarmStatusResponse> = await res.json();
  const coerced: Record<number, SwarmStatusResponse> = {};
  for (const [k, v] of Object.entries(json)) coerced[Number(k)] = v;
  return coerced;
}

function useSwarmBatchSse(sessionIds: number[], readySessionIds: number[]) {
  const [statusMap, setStatusMap] = useState<Record<number, SwarmStatusResponse>>({});
  const allIdsKey = sessionIds.slice().sort((a, b) => a - b).join(",");
  const readyIdsKey = readySessionIds.slice().sort((a, b) => a - b).join(",");

  // Keep a mutable ref so fallback callbacks always use the freshest allIdsKey
  // even when the SSE effect hasn't re-run yet.
  const allIdsKeyRef = useRef(allIdsKey);
  useEffect(() => { allIdsKeyRef.current = allIdsKey; }, [allIdsKey]);

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

    // Start batch polling as an immediate fallback — called on the first SSE error
    // so no pill goes stale while EventSource is reconnecting.
    const startPollingFallback = () => {
      if (fallbackInterval) return;
      const doFetch = () => {
        const key = allIdsKeyRef.current;
        if (!key) return;
        fetchBatchStatus(key)
          .then((data) => setStatusMap((prev) => ({ ...prev, ...data })))
          .catch(() => {});
      };
      doFetch();
      fallbackInterval = setInterval(doFetch, BATCH_INTERVAL_MS);
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
  }, [readyIdsKey]); // allIdsKey tracked via ref so fallback always uses current IDs

  return statusMap;
}

type TeamFilter = "all" | "team" | "solo";

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

export default function SessionsList() {
  const [, setLocation] = useLocation();
  const { data: sessions, isLoading } = useListSessions();
  const [teamFilter, setTeamFilter] = useState<TeamFilter>("all");

  const filteredSessions = sessions?.filter((session) => {
    if (teamFilter === "team") return session.teamMembers && session.teamMembers.length > 0;
    if (teamFilter === "solo") return !session.teamMembers || session.teamMembers.length === 0;
    return true;
  });

  const sessionIds = useMemo(() => sessions?.map(s => s.id) ?? [], [sessions]);
  const readySessionIds = useMemo(() => sessions?.filter(s => s.status === "ready").map(s => s.id) ?? [], [sessions]);
  const swarmStatusMap = useSwarmBatchSse(sessionIds, readySessionIds);

  const idsParam = useMemo(
    () => sessionIds.length > 0 ? sessionIds.join(",") : undefined,
    [sessionIds]
  );

  const { data: repoStatuses } = useGetBatchRepoStatus(
    { ids: idsParam! },
    { query: { enabled: !!idsParam, queryKey: getGetBatchRepoStatusQueryKey(idsParam ? { ids: idsParam } : undefined) } }
  );

  const repoStatusMap = repoStatuses?.statuses ?? {};

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
      if (!filteredSessions || filteredSessions.length === 0) {
        if (e.key === "n") {
          e.preventDefault();
          setLocation("/");
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
        setLocation("/");
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
                        <span className="text-xs text-muted-foreground">—</span>
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
                  {teamFilter === "all"
                    ? "No sessions found"
                    : `No ${teamFilter} sessions found`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
