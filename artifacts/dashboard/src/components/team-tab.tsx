import { useState, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  useListSessionLanes,
  useGetSessionConflicts,
  useListHeavyJobs,
  useGetSessionCoordination,
  useReleaseLaneClaim,
  useCreateLaneHandoff,
  useAcknowledgeLaneHandoff,
  useCreateSessionLane,
  getListSessionLanesQueryKey,
  getGetSessionConflictsQueryKey,
  getListHeavyJobsQueryKey,
  getGetSessionCoordinationQueryKey,
} from "@workspace/api-client-react";
import { useCoordinationStream } from "@/hooks/use-coordination-stream";
import { useToast } from "@/hooks/use-toast";
import type {
  LaneWithPolicy,
  ConflictItem,
  HeavyJobResponse,
  HandoffResponse,
  CreateHandoffRequest,
} from "@workspace/api-client-react";
import { API_BASE_URL } from "@/lib/api-url";
import { LaneTimeline, type LaneEventItem } from "@/components/lane-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Users,
  AlertTriangle,
  XCircle,
  Loader2,
  FolderOpen,
  ArrowRight,
  Zap,
  Bell,
  X,
  Send,
  CheckCircle2,
  Plus,
  GitPullRequest,
  ExternalLink,
  History,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface LaneTypeOption {
  name: string;
  description: string;
  isBuiltin: boolean;
}

async function fetchLaneTypeOptions(): Promise<LaneTypeOption[]> {
  const res = await fetch(`${API_BASE_URL}api/coordination/lane-types`);
  if (!res.ok) return [];
  const data = await res.json() as { all: LaneTypeOption[] };
  return data.all ?? [];
}

function AddLaneDialog({
  sessionId,
  onSuccess,
}: {
  sessionId: number;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [memberIdentifier, setMemberIdentifier] = useState("");
  const [laneType, setLaneType] = useState("general");
  const [currentTask, setCurrentTask] = useState("");
  const { toast } = useToast();

  const { data: laneTypeOptions = [] } = useQuery({
    queryKey: ["lane-types-options"],
    queryFn: fetchLaneTypeOptions,
    staleTime: 60_000,
  });

  const mutation = useCreateSessionLane();

  function handleSubmit() {
    const member = memberIdentifier.trim();
    if (!member) return;

    mutation.mutate(
      {
        id: sessionId,
        data: {
          memberIdentifier: member,
          laneType: laneType as import("@workspace/api-client-react").CreateLaneRequestLaneType,
          currentTask: currentTask.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setMemberIdentifier("");
          setLaneType("general");
          setCurrentTask("");
          toast({ title: `Lane added for ${member}` });
          onSuccess();
        },
        onError: (err: Error) => {
          toast({ variant: "destructive", title: "Failed to add lane", description: err?.message ?? "Please try again." });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px] gap-1 border-border/50 text-muted-foreground hover:text-foreground"
        >
          <Plus className="w-2.5 h-2.5" />
          Add lane
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Add Member Lane
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="add-lane-member" className="text-xs text-muted-foreground">
              Member identifier
            </Label>
            <Input
              id="add-lane-member"
              value={memberIdentifier}
              onChange={(e) => setMemberIdentifier(e.target.value)}
              placeholder="e.g. alice, ml-agent, bob"
              className="h-8 text-xs"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-lane-type" className="text-xs text-muted-foreground">
              Lane type
            </Label>
            <Select value={laneType} onValueChange={setLaneType}>
              <SelectTrigger id="add-lane-type" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {laneTypeOptions.length > 0 ? (
                  laneTypeOptions.map((lt) => (
                    <SelectItem key={lt.name} value={lt.name} className="text-xs">
                      <span className="capitalize">{lt.name}</span>
                      {!lt.isBuiltin && (
                        <span className="ml-1.5 text-[10px] text-primary/70">(custom)</span>
                      )}
                    </SelectItem>
                  ))
                ) : (
                  ["general", "ux", "backend", "debug", "review"].map((t) => (
                    <SelectItem key={t} value={t} className="text-xs capitalize">{t}</SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {laneTypeOptions.find((lt) => lt.name === laneType)?.description && (
              <p className="text-[10px] text-muted-foreground/70">
                {laneTypeOptions.find((lt) => lt.name === laneType)?.description}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-lane-task" className="text-xs text-muted-foreground">
              Current task <span className="opacity-50">(optional)</span>
            </Label>
            <Input
              id="add-lane-task"
              value={currentTask}
              onChange={(e) => setCurrentTask(e.target.value)}
              placeholder="What is this member working on?"
              className="h-8 text-xs"
            />
          </div>

          {mutation.isError && (
            <p className="text-xs text-red-400">Failed to add lane. Please try again.</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleSubmit}
              disabled={mutation.isPending || !memberIdentifier.trim()}
            >
              {mutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Add lane
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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

const HANDOFF_TYPES: Array<{ value: CreateHandoffRequest["handoffType"]; label: string }> = [
  { value: "blocked", label: "Blocked" },
  { value: "needs_review", label: "Needs Review" },
  { value: "safe_to_merge", label: "Safe to Merge" },
  { value: "watch_files", label: "Watch Files" },
  { value: "related_lane", label: "Related Lane" },
];

function SendHandoffDialog({
  sessionId,
  lane,
  allLanes,
  onSuccess,
}: {
  sessionId: number;
  lane: LaneWithPolicy;
  allLanes: LaneWithPolicy[];
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [handoffType, setHandoffType] = useState<CreateHandoffRequest["handoffType"]>("needs_review");
  const [targetLaneId, setTargetLaneId] = useState<string>("all");
  const [message, setMessage] = useState("");

  const mutation = useCreateLaneHandoff();
  const isPending = mutation.status === "pending";
  const { toast } = useToast();

  const otherLanes = allLanes.filter((l) => l.id !== lane.id);

  function handleSubmit() {
    const toLaneIds = targetLaneId === "all" ? [] : [Number(targetLaneId)];
    mutation.mutate(
      {
        id: sessionId,
        laneId: lane.id,
        data: {
          handoffType,
          toLaneIds,
          resourcePaths: lane.claims.map((c) => c.resourcePath),
          message: message.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setMessage("");
          setHandoffType("needs_review");
          setTargetLaneId("all");
          toast({ title: "Handoff sent" });
          onSuccess();
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to send handoff", description: "Please try again." });
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px] gap-1 border-border/50 text-muted-foreground hover:text-foreground"
        >
          <Send className="w-2.5 h-2.5" />
          Send handoff
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Send className="w-4 h-4" />
            Send Handoff Signal
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">From lane</Label>
            <p className="text-sm font-medium">{lane.memberIdentifier}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="handoff-type">
              Handoff type
            </Label>
            <Select
              value={handoffType}
              onValueChange={(v) => setHandoffType(v as CreateHandoffRequest["handoffType"])}
            >
              <SelectTrigger id="handoff-type" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HANDOFF_TYPES.map((ht) => (
                  <SelectItem key={ht.value} value={ht.value} className="text-xs">
                    {ht.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="target-lane">
              Target lane
            </Label>
            <Select value={targetLaneId} onValueChange={setTargetLaneId}>
              <SelectTrigger id="target-lane" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All lanes (broadcast)</SelectItem>
                {otherLanes.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)} className="text-xs">
                    {l.memberIdentifier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="handoff-message">
              Message <span className="opacity-50">(optional)</span>
            </Label>
            <Textarea
              id="handoff-message"
              placeholder="Add a note for the recipient..."
              className="h-16 text-xs resize-none"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          {mutation.isError && (
            <p className="text-xs text-red-400">Failed to send handoff. Please try again.</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleSubmit}
              disabled={isPending}
            >
              {isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Send
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClaimRow({
  claim,
  sessionId,
  laneId,
  isConflicted,
  conflictSeverity,
  onReleased,
}: {
  claim: LaneWithPolicy["claims"][number];
  sessionId: number;
  laneId: number;
  isConflicted: boolean;
  conflictSeverity: string | undefined;
  onReleased: () => void;
}) {
  const mutation = useReleaseLaneClaim();
  const isPending = mutation.status === "pending";
  const { toast } = useToast();

  function handleRelease() {
    mutation.mutate(
      { id: sessionId, laneId, claimId: claim.id },
      {
        onSuccess: () => {
          toast({ title: "Claim released" });
          onReleased();
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to release claim", description: "Please try again." });
        },
      }
    );
  }

  return (
    <div
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
      <button
        onClick={handleRelease}
        disabled={isPending}
        title="Release claim"
        className="ml-0.5 shrink-0 text-muted-foreground/50 hover:text-red-400 transition-colors disabled:opacity-40"
      >
        {isPending ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <X className="w-3 h-3" />
        )}
      </button>
    </div>
  );
}

function LaneCard({
  lane,
  conflicts,
  sessionId,
  allLanes,
  onMutationSuccess,
}: {
  lane: LaneWithPolicy;
  conflicts: ConflictItem[];
  sessionId: number;
  allLanes: LaneWithPolicy[];
  onMutationSuccess: () => void;
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
          <SendHandoffDialog
            sessionId={sessionId}
            lane={lane}
            allLanes={allLanes}
            onSuccess={onMutationSuccess}
          />
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
                <ClaimRow
                  key={claim.id}
                  claim={claim}
                  sessionId={sessionId}
                  laneId={lane.id}
                  isConflicted={isConflicted}
                  conflictSeverity={conflictSeverity}
                  onReleased={onMutationSuccess}
                />
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

type HandoffResponseWithPr = HandoffResponse & { prUrl?: string | null };

function HandoffFeedItem({
  handoff,
  lanes,
  sessionId,
  onAction,
}: {
  handoff: HandoffResponseWithPr;
  lanes: LaneWithPolicy[];
  sessionId: number;
  onAction: () => void;
}) {
  const laneById = Object.fromEntries(lanes.map((l) => [l.id, l]));
  const fromLane = laneById[handoff.fromLaneId];
  const toLanes = handoff.toLaneIds.map((id) => laneById[id]?.memberIdentifier ?? `Lane ${id}`);

  const acknowledgeMutation = useAcknowledgeLaneHandoff();
  const isPending = handoff.status === "pending";
  const isActing = acknowledgeMutation.isPending;

  function handleAcknowledge() {
    acknowledgeMutation.mutate(
      { id: sessionId, laneId: handoff.fromLaneId, handoffId: handoff.id, data: { status: "acknowledged" } },
      { onSuccess: onAction },
    );
  }

  function handleDismiss() {
    acknowledgeMutation.mutate(
      { id: sessionId, laneId: handoff.fromLaneId, handoffId: handoff.id, data: { status: "dismissed" } },
      { onSuccess: onAction },
    );
  }

  const statusBadge = handoff.status !== "pending" && (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
      handoff.status === "acknowledged"
        ? "bg-emerald-500/15 text-emerald-400"
        : handoff.status === "dismissed"
        ? "bg-secondary/60 text-muted-foreground"
        : "bg-secondary/60 text-muted-foreground"
    }`}>
      {handoff.status}
    </span>
  );

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
          {statusBadge}
        </div>
        {handoff.resourcePaths.length > 0 && (
          <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5 truncate">
            {handoff.resourcePaths.join(", ")}
          </p>
        )}
        {handoff.message && (
          <p className="text-[11px] text-muted-foreground mt-0.5 italic">{handoff.message}</p>
        )}
        {handoff.handoffType === "safe_to_merge" && handoff.prUrl && (
          <a
            href={handoff.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <GitPullRequest className="w-3 h-3" />
            View draft PR
            <ExternalLink className="w-2.5 h-2.5 opacity-70" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[10px] text-muted-foreground/60">
          {formatDistanceToNow(new Date(handoff.createdAt), { addSuffix: true })}
        </span>
        {isPending && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
              title="Acknowledge"
              disabled={isActing}
              onClick={handleAcknowledge}
            >
              {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              title="Dismiss"
              disabled={isActing}
              onClick={handleDismiss}
            >
              <X className="w-3 h-3" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function StreamStatusBadge({ status }: { status: import("@/hooks/use-coordination-stream").CoordinationStreamStatus }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
        </span>
        Live
      </span>
    );
  }
  if (status === "reconnecting") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400 animate-pulse" />
        </span>
        Reconnecting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground/60">
      <span className="relative flex h-1.5 w-1.5">
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-muted-foreground/40" />
      </span>
      Polling
    </span>
  );
}

type TeamSubTab = "overview" | "timeline";

export function TeamTab({ sessionId }: { sessionId: number }) {
  const [subTab, setSubTab] = useState<TeamSubTab>("overview");
  const [latestLaneEvent, setLatestLaneEvent] = useState<LaneEventItem | null>(null);
  const latestLaneEventRef = useRef<LaneEventItem | null>(null);

  const streamStatus = useCoordinationStream(sessionId, {
    onLaneEvent: (event) => {
      latestLaneEventRef.current = event;
      setLatestLaneEvent(event);
    },
  });
  const queryClient = useQueryClient();

  const { data: lanesData, isLoading: lanesLoading, isError: lanesError } = useListSessionLanes(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getListSessionLanesQueryKey(sessionId),
      refetchInterval: 5000,
    },
  });

  const { data: conflictsData, isLoading: conflictsLoading, isError: conflictsError } = useGetSessionConflicts(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionConflictsQueryKey(sessionId),
      refetchInterval: 5000,
    },
  });

  const { data: jobsData, isLoading: jobsLoading, isError: jobsError } = useListHeavyJobs(
    sessionId,
    { status: "queued,running,deferred" },
    {
      query: {
        enabled: !!sessionId,
        queryKey: getListHeavyJobsQueryKey(sessionId, { status: "queued,running,deferred" }),
        refetchInterval: 5000,
      },
    }
  );

  const { data: coordData, isLoading: coordLoading, isError: coordError } = useGetSessionCoordination(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionCoordinationQueryKey(sessionId),
      refetchInterval: 5000,
    },
  });

  const isLoading = lanesLoading || conflictsLoading || jobsLoading || coordLoading;
  const hasError = lanesError || conflictsError || jobsError || coordError;

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: getListSessionLanesQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionConflictsQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionCoordinationQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getListHeavyJobsQueryKey(sessionId, { status: "queued,running,deferred" }) });
  }

  const [showResolvedHandoffs, setShowResolvedHandoffs] = useState(() => {
    try {
      return localStorage.getItem('handoff-show-resolved') === 'true';
    } catch {
      return false;
    }
  });

  const handleSetShowResolvedHandoffs = (value: boolean) => {
    try {
      localStorage.setItem('handoff-show-resolved', String(value));
    } catch {
    }
    setShowResolvedHandoffs(value);
  };

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

  const pendingHandoffs = recentHandoffs.filter((h) => h.status === "pending");
  const resolvedHandoffs = recentHandoffs.filter((h) => h.status !== "pending");
  const visibleHandoffs = showResolvedHandoffs ? recentHandoffs : pendingHandoffs;

  const noData = lanes.length === 0 && jobs.length === 0 && recentHandoffs.length === 0;

  if (noData && !hasError) {
    return (
      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Team Coordination
          </p>
          <StreamStatusBadge status={streamStatus} />
        </div>
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p>No team activity yet.</p>
            <p className="text-xs mt-1 opacity-70">
              Team lanes appear here once members join and start claiming files or tasks.
            </p>
            <div className="mt-4 flex justify-center">
              <AddLaneDialog sessionId={sessionId} onSuccess={invalidateAll} />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (noData && hasError) {
    return (
      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Team Coordination
          </p>
          <StreamStatusBadge status={streamStatus} />
        </div>
        <div className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Could not load team coordination data. Will retry automatically.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5">

      {/* Stream status header + sub-tab switcher */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSubTab("overview")}
            className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide px-2 py-1 rounded transition-colors ${
              subTab === "overview"
                ? "bg-secondary/60 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="w-3.5 h-3.5" /> Overview
          </button>
          <button
            onClick={() => setSubTab("timeline")}
            className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide px-2 py-1 rounded transition-colors ${
              subTab === "timeline"
                ? "bg-secondary/60 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="w-3.5 h-3.5" /> Timeline
          </button>
        </div>
        <StreamStatusBadge status={streamStatus} />
      </div>

      {/* Timeline sub-tab */}
      {subTab === "timeline" && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <History className="w-4 h-4" /> Lane Activity Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lanes.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground/50 text-xs">
                No lanes in this session yet. Timeline will appear once lanes are created.
              </div>
            ) : (
              <LaneTimeline
                sessionId={sessionId}
                lanes={lanes}
                incomingEvent={latestLaneEvent}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Overview sub-tab */}
      {subTab === "overview" && (<>

      {/* Error banner */}
      {hasError && (
        <div className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Some coordination data failed to load. Showing available results — will retry automatically.</span>
        </div>
      )}

      {/* Lane Activity */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Member Lanes ({lanes.length})
          </p>
          <div className="flex items-center gap-2">
            {conflicts.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {conflicts.filter((c) => c.recommendation === "block").length > 0
                  ? `${conflicts.filter((c) => c.recommendation === "block").length} blocking conflict${conflicts.filter((c) => c.recommendation === "block").length !== 1 ? "s" : ""}`
                  : `${conflicts.length} warning${conflicts.length !== 1 ? "s" : ""}`}
              </p>
            )}
            <AddLaneDialog sessionId={sessionId} onSuccess={invalidateAll} />
          </div>
        </div>
        {lanes.length > 0 && (
          <div className="space-y-2">
            {lanes.map((lane) => (
              <LaneCard
                key={lane.id}
                lane={lane}
                conflicts={conflicts}
                sessionId={sessionId}
                allLanes={lanes}
                onMutationSuccess={invalidateAll}
              />
            ))}
          </div>
        )}
      </div>

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
      {(pendingHandoffs.length > 0 || resolvedHandoffs.length > 0) && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Bell className="w-4 h-4" /> Handoff Signals
              <Badge variant="outline" className="ml-auto text-[10px] font-normal normal-case tracking-normal bg-secondary/60 text-muted-foreground border-border/40">
                {pendingHandoffs.length} pending
              </Badge>
              {resolvedHandoffs.length > 0 && (
                <button
                  onClick={() => handleSetShowResolvedHandoffs(!showResolvedHandoffs)}
                  className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground underline underline-offset-2 transition-colors font-normal normal-case tracking-normal"
                >
                  {showResolvedHandoffs ? "Hide resolved" : `Show resolved (${resolvedHandoffs.length})`}
                </button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {visibleHandoffs.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 text-center py-2">No pending handoffs.</p>
            ) : (
              (visibleHandoffs as HandoffResponseWithPr[]).map((handoff) => (
                <HandoffFeedItem
                  key={handoff.id}
                  handoff={handoff}
                  lanes={lanes}
                  sessionId={sessionId}
                  onAction={() => {
                    queryClient.invalidateQueries({ queryKey: getGetSessionCoordinationQueryKey(sessionId) });
                    if (pendingHandoffs.length <= 1) {
                      setShowResolvedHandoffs(false);
                    }
                  }}
                />
              ))
            )}
          </CardContent>
        </Card>
      )}

      </>)}

    </div>
  );
}
