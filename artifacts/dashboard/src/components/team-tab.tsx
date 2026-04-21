import {
  useListSessionLanes,
  useGetSessionConflicts,
  useListHeavyJobs,
  useGetSessionCoordination,
  getListSessionLanesQueryKey,
  getGetSessionConflictsQueryKey,
  getListHeavyJobsQueryKey,
  getGetSessionCoordinationQueryKey,
} from "@workspace/api-client-react";
import type {
  LaneWithPolicy,
  ConflictItem,
  HeavyJobResponse,
  HandoffResponse,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  AlertTriangle,
  XCircle,
  Loader2,
  FolderOpen,
  ArrowRight,
  Zap,
  Bell,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

function LaneStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: "Active", className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    idle: { label: "Idle", className: "bg-secondary/60 text-muted-foreground border-border/40" },
    blocked: { label: "Blocked", className: "bg-red-500/20 text-red-400 border-red-500/30" },
    "review-needed": { label: "Review Needed", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    "ready-to-merge": { label: "Ready to Merge", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  };
  const cfg = map[status] ?? { label: status, className: "bg-secondary/60 text-muted-foreground border-border/40" };
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}

function ClaimTypeBadge({ claimType }: { claimType: string }) {
  const map: Record<string, string> = {
    file: "bg-primary/10 text-primary/70 border-primary/20",
    module: "bg-violet-500/10 text-violet-400 border-violet-500/20",
    symbol: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    task: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  };
  return (
    <Badge variant="outline" className={`text-[9px] px-1 py-0 ${map[claimType] ?? ""}`}>
      {claimType}
    </Badge>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  if (status === "running") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-sky-500/20 text-sky-400 border-sky-500/30 gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Running
      </Badge>
    );
  }
  if (status === "queued") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/20 text-amber-400 border-amber-500/30">
        Queued
      </Badge>
    );
  }
  if (status === "deferred") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-secondary/60 text-muted-foreground border-border/40">
        Deferred
      </Badge>
    );
  }
  if (status === "completed") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
        Completed
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-500/20 text-red-400 border-red-500/30">
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{status}</Badge>
  );
}

function HandoffTypeBadge({ handoffType }: { handoffType: string }) {
  const map: Record<string, { label: string; className: string }> = {
    blocked: { label: "Blocked", className: "bg-red-500/20 text-red-400 border-red-500/30" },
    needs_review: { label: "Needs Review", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    safe_to_merge: { label: "Safe to Merge", className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    watch_files: { label: "Watch Files", className: "bg-violet-500/20 text-violet-400 border-violet-500/30" },
    related_lane: { label: "Related Lane", className: "bg-sky-500/20 text-sky-400 border-sky-500/30" },
  };
  const cfg = map[handoffType] ?? { label: handoffType, className: "bg-secondary/60 text-muted-foreground border-border/40" };
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}

function LaneCard({
  lane,
  conflicts,
}: {
  lane: LaneWithPolicy;
  conflicts: ConflictItem[];
}) {
  const laneConflicts = conflicts.filter(
    (c) => c.laneIdA === lane.id || c.laneIdB === lane.id
  );
  const hasBlock = laneConflicts.some((c) => c.recommendation === "block");
  const hasWarn = laneConflicts.some((c) => c.recommendation === "warn");

  return (
    <div
      className={`border rounded-lg p-3 space-y-2 transition-colors ${
        hasBlock
          ? "border-red-500/40 bg-red-500/5"
          : hasWarn
          ? "border-yellow-500/40 bg-yellow-500/5"
          : "border-border/50 bg-card/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
            <span className="text-[11px] font-bold text-primary uppercase">
              {lane.memberIdentifier[0] ?? "?"}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{lane.memberIdentifier}</p>
            <p className="text-[10px] text-muted-foreground capitalize">{lane.laneType} lane</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasBlock && <XCircle className="w-3.5 h-3.5 text-red-400" />}
          {!hasBlock && hasWarn && <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />}
          <LaneStatusBadge status={lane.status} />
        </div>
      </div>

      {lane.currentTask && (
        <p className="text-xs text-muted-foreground bg-secondary/30 rounded px-2 py-1 truncate" title={lane.currentTask}>
          <span className="text-foreground/60 mr-1">Task:</span>{lane.currentTask}
        </p>
      )}

      {lane.claims.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Claims ({lane.claims.length})
          </p>
          <div className="space-y-0.5">
            {lane.claims.map((claim) => {
              const isConflicted = conflicts.some(
                (c) =>
                  c.conflictingResources.includes(claim.resourcePath) &&
                  (c.laneIdA === lane.id || c.laneIdB === lane.id)
              );
              const conflictSeverity = conflicts.find(
                (c) =>
                  c.conflictingResources.includes(claim.resourcePath) &&
                  (c.laneIdA === lane.id || c.laneIdB === lane.id)
              )?.recommendation;
              return (
                <div
                  key={claim.id}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-mono ${
                    conflictSeverity === "block"
                      ? "bg-red-500/10 border border-red-500/20"
                      : conflictSeverity === "warn"
                      ? "bg-yellow-500/10 border border-yellow-500/20"
                      : "bg-secondary/20"
                  }`}
                >
                  <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1 text-foreground/80" title={claim.resourcePath}>
                    {claim.resourcePath}
                  </span>
                  <ClaimTypeBadge claimType={claim.claimType} />
                  {isConflicted && conflictSeverity === "block" && (
                    <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                  )}
                  {isConflicted && conflictSeverity === "warn" && (
                    <AlertTriangle className="w-3 h-3 text-yellow-400 shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {lane.claims.length === 0 && (
        <p className="text-[11px] text-muted-foreground/60 italic">No active claims</p>
      )}
    </div>
  );
}

function ConflictsPanel({
  conflicts,
  lanes,
}: {
  conflicts: ConflictItem[];
  lanes: LaneWithPolicy[];
}) {
  const laneById = Object.fromEntries(lanes.map((l) => [l.id, l]));

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
          <AlertTriangle className="w-4 h-4" /> Conflict Warnings
          <span className="ml-auto flex items-center gap-1.5">
            {conflicts.filter((c) => c.recommendation === "block").length > 0 && (
              <Badge variant="outline" className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30 font-normal normal-case tracking-normal">
                {conflicts.filter((c) => c.recommendation === "block").length} blocking
              </Badge>
            )}
            {conflicts.filter((c) => c.recommendation === "warn").length > 0 && (
              <Badge variant="outline" className="text-[10px] bg-yellow-500/20 text-yellow-400 border-yellow-500/30 font-normal normal-case tracking-normal">
                {conflicts.filter((c) => c.recommendation === "warn").length} warning
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {conflicts.map((conflict, i) => {
          const laneA = laneById[conflict.laneIdA];
          const laneB = laneById[conflict.laneIdB];
          const isBlock = conflict.recommendation === "block";
          return (
            <div
              key={i}
              className={`border rounded-lg p-3 space-y-2 ${
                isBlock
                  ? "border-red-500/40 bg-red-500/5"
                  : "border-yellow-500/40 bg-yellow-500/5"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                {isBlock ? (
                  <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                )}
                <span className={`text-xs font-semibold ${isBlock ? "text-red-400" : "text-yellow-400"}`}>
                  {isBlock ? "Blocked" : "Warning"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {laneA?.memberIdentifier ?? `Lane ${conflict.laneIdA}`}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {laneB?.memberIdentifier ?? `Lane ${conflict.laneIdB}`}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/60">
                  overlap {Math.round(conflict.overlapScore * 100)}%
                </span>
              </div>
              {conflict.conflictingResources.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {conflict.conflictingResources.map((r) => (
                    <span
                      key={r}
                      className="text-[10px] font-mono bg-secondary/40 rounded px-1.5 py-0.5 text-foreground/70 max-w-full truncate"
                      title={r}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )}
              {conflict.detail && (
                <p className="text-[11px] text-muted-foreground">{conflict.detail}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function HeavyJobRow({ job }: { job: HeavyJobResponse }) {
  return (
    <div className="flex items-center gap-2 border border-border/40 rounded px-2 py-1.5 text-xs">
      <Zap className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="font-mono text-foreground/80 truncate flex-1 capitalize">
        {job.jobClass.replace(/_/g, " ")}
        {job.memberIdentifier && (
          <span className="text-muted-foreground ml-1">· {job.memberIdentifier}</span>
        )}
      </span>
      <span className="text-[10px] text-muted-foreground shrink-0">
        score {job.score.toFixed(2)}
      </span>
      <JobStatusBadge status={job.status} />
    </div>
  );
}

function HandoffFeedItem({
  handoff,
  lanes,
}: {
  handoff: HandoffResponse;
  lanes: LaneWithPolicy[];
}) {
  const laneById = Object.fromEntries(lanes.map((l) => [l.id, l]));
  const fromLane = laneById[handoff.fromLaneId];
  const toLanes = handoff.toLaneIds.map((id) => laneById[id]?.memberIdentifier ?? `Lane ${id}`);

  return (
    <div className="flex items-start gap-2 text-xs border-b border-border/30 pb-2 last:border-0 last:pb-0">
      <Bell className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-foreground/90">
            {fromLane?.memberIdentifier ?? `Lane ${handoff.fromLaneId}`}
          </span>
          <HandoffTypeBadge handoffType={handoff.handoffType} />
          {toLanes.length > 0 && (
            <span className="text-muted-foreground">
              → {toLanes.join(", ")}
            </span>
          )}
        </div>
        {handoff.resourcePaths.length > 0 && (
          <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5 truncate">
            {handoff.resourcePaths.join(", ")}
          </p>
        )}
        {handoff.message && (
          <p className="text-[11px] text-muted-foreground mt-0.5 italic">{handoff.message}</p>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5">
        {formatDistanceToNow(new Date(handoff.createdAt), { addSuffix: true })}
      </span>
    </div>
  );
}

export function TeamTab({ sessionId }: { sessionId: number }) {
  const { data: lanesData, isLoading: lanesLoading, isError: lanesError } = useListSessionLanes(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getListSessionLanesQueryKey(sessionId),
      refetchInterval: 15000,
    },
  });

  const { data: conflictsData, isLoading: conflictsLoading, isError: conflictsError } = useGetSessionConflicts(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionConflictsQueryKey(sessionId),
      refetchInterval: 20000,
    },
  });

  const { data: jobsData, isLoading: jobsLoading, isError: jobsError } = useListHeavyJobs(
    sessionId,
    { status: "queued,running,deferred" },
    {
      query: {
        enabled: !!sessionId,
        queryKey: getListHeavyJobsQueryKey(sessionId, { status: "queued,running,deferred" }),
        refetchInterval: 15000,
      },
    }
  );

  const { data: coordData, isLoading: coordLoading, isError: coordError } = useGetSessionCoordination(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionCoordinationQueryKey(sessionId),
      refetchInterval: 20000,
    },
  });

  const isLoading = lanesLoading || conflictsLoading || jobsLoading || coordLoading;
  const hasError = lanesError || conflictsError || jobsError || coordError;

  if (isLoading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const lanes = lanesData?.lanes ?? [];
  const conflicts = (conflictsData?.conflicts ?? []).filter(
    (c) => c.recommendation !== "no_conflict"
  );
  const jobs = jobsData?.jobs ?? [];
  const recentHandoffs = coordData?.recentHandoffs ?? [];

  const noData = lanes.length === 0 && jobs.length === 0 && recentHandoffs.length === 0;

  if (noData && !hasError) {
    return (
      <div className="mt-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p>No team activity yet.</p>
            <p className="text-xs mt-1 opacity-70">
              Team lanes appear here once members join and start claiming files or tasks.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (noData && hasError) {
    return (
      <div className="mt-4">
        <div className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Could not load team coordination data. Will retry automatically.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5">

      {/* Error banner */}
      {hasError && (
        <div className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Some coordination data failed to load. Showing available results — will retry automatically.</span>
        </div>
      )}

      {/* Lane Activity */}
      {lanes.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> Member Lanes ({lanes.length})
            </p>
            {conflicts.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {conflicts.filter((c) => c.recommendation === "block").length > 0
                  ? `${conflicts.filter((c) => c.recommendation === "block").length} blocking conflict${conflicts.filter((c) => c.recommendation === "block").length !== 1 ? "s" : ""}`
                  : `${conflicts.length} warning${conflicts.length !== 1 ? "s" : ""}`}
              </p>
            )}
          </div>
          <div className="space-y-2">
            {lanes.map((lane) => (
              <LaneCard key={lane.id} lane={lane} conflicts={conflicts} />
            ))}
          </div>
        </div>
      )}

      {/* Conflicts Panel */}
      {conflicts.length > 0 && (
        <ConflictsPanel conflicts={conflicts} lanes={lanes} />
      )}

      {/* Heavy Job Queue */}
      {jobs.length > 0 && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Zap className="w-4 h-4" /> Heavy Job Queue
              <Badge variant="outline" className="ml-auto text-[10px] font-normal normal-case tracking-normal bg-secondary/60 text-muted-foreground border-border/40">
                {jobs.length} job{jobs.length !== 1 ? "s" : ""}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {jobs.map((job) => (
              <HeavyJobRow key={job.id} job={job} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Handoff Feed */}
      {recentHandoffs.length > 0 && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Bell className="w-4 h-4" /> Handoff Signals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentHandoffs.map((handoff) => (
              <HandoffFeedItem key={handoff.id} handoff={handoff} lanes={lanes} />
            ))}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
