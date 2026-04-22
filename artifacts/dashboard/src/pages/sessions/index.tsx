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

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const BATCH_INTERVAL_MS = 3000;

function useSwarmBatchStatus(sessionIds: number[], hasReadySessions: boolean) {
  const [statusMap, setStatusMap] = useState<Record<number, SwarmStatusResponse>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idsKey = sessionIds.slice().sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (sessionIds.length === 0) {
      setStatusMap({});
      return;
    }

    const fetchBatch = async () => {
      try {
        const res = await fetch(`${BASE_URL}api/sessions/swarm-status-batch?ids=${idsKey}`);
        if (!res.ok) return;
        const json: Record<string, SwarmStatusResponse> = await res.json();
        const coerced: Record<number, SwarmStatusResponse> = {};
        for (const [k, v] of Object.entries(json)) {
          coerced[Number(k)] = v;
        }
        setStatusMap(coerced);
      } catch {
        // Keep stale data on network error
      }
    };

    // Fetch once on mount so historical swarm data is shown even for stopped sessions.
    fetchBatch();

    // Only keep a live polling interval when at least one session is ready —
    // stopped/error sessions don't receive new swarm pushes so there's nothing to refresh.
    if (!hasReadySessions) return;

    timerRef.current = setInterval(fetchBatch, BATCH_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [idsKey, hasReadySessions]);

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
  const hasReadySessions = sessions?.some((s) => s.status === "ready") ?? false;
  const swarmStatusMap = useSwarmBatchStatus(sessionIds, hasReadySessions);

  const idsParam = useMemo(
    () => sessionIds.length > 0 ? sessionIds.join(",") : undefined,
    [sessionIds]
  );

  const { data: repoStatuses } = useGetBatchRepoStatus(
    { ids: idsParam! },
    { query: { enabled: !!idsParam, queryKey: getGetBatchRepoStatusQueryKey(idsParam ? { ids: idsParam } : undefined) } }
  );

  const repoStatusMap = repoStatuses?.statuses ?? {};

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
              filteredSessions.map((session) => {
                const repoStatus = repoStatusMap[session.id];
                return (
                  <TableRow key={session.id} className="border-border/50">
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
                        <RepoStatusBadge
                          indexStatus={repoStatus.indexStatus}
                          isStale={repoStatus.isStale}
                        />
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
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setLocation(`/sessions/${session.id}`)}
                        title="View Details"
                      >
                        <Eye className="w-4 h-4 text-primary" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  No sessions found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
