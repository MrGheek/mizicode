import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, Loader2, FileCode2, AlertCircle, ListTodo, Clock,
  CheckSquare, Circle, SkipForward, ChevronDown, ChevronRight, ListChecks, Eye,
} from "lucide-react";
import { TaskDetailDrawer, type TaskDetail } from "./task-detail-drawer";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

// ── Live plan-status types (MIZI active-task snapshot) ────────────────────────

export interface PlanSnapshot {
  activeTask?: string | null;
  planCheckpoint?: string | null;
  activeFiles?: string[];
  unresolvedErrors?: string[];
  taskSummary?: string | null;
  bundleSlug?: string | null;
  updatedAt: string;
}

export interface PlanStatusResponse {
  availability: "live" | "stale" | "starting" | "unavailable";
  snapshot: PlanSnapshot | null;
}

// ── Board-task types (project plan from plans table) ──────────────────────────

type PlanTaskStatus = "planned" | "in_progress" | "done" | "partial" | "skipped";

interface ProjectPlan {
  id: number;
  userId: string;
  repoUrl: string | null;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ProjectTask {
  id: number;
  planId: number;
  stepIndex: number;
  text: string;
  status: PlanTaskStatus;
  priority: "high" | "normal" | "low";
  confirmedByUser: boolean;
  completedAt: string | null;
  doneLooksLike: string | null;
  outOfScope: string | null;
  fileDependencies: string | null;
}

interface SessionPlanResponse {
  plan: ProjectPlan | null;
  tasks: ProjectTask[];
}

// ── Hook: live MIZI plan-status (SSE + poll fallback) ────────────────────────

function usePlanStatus(sessionId: number, isActive: boolean): PlanStatusResponse {
  const [state, setState] = useState<PlanStatusResponse>({
    availability: "unavailable",
    snapshot: null,
  });
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const fetchOnce = () => {
      fetch(`${BASE_URL}api/sessions/${sessionId}/plan-status`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: PlanStatusResponse | null) => { if (data && !cancelled) setState(data); })
        .catch(() => {});
    };

    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (cancelled) return;
        fetchOnce();
      }, 8000);
    };

    fetchOnce();

    if (isActive) {
      const url = `${BASE_URL}api/sessions/${sessionId}/plan-stream`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data) as PlanStatusResponse;
          setState(data);
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        startPolling();
      };
    }

    return () => {
      cancelled = true;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [sessionId, isActive]);

  return state;
}

export function usePlanProgressStatus(sessionId: number, isActive: boolean) {
  return usePlanStatus(sessionId, isActive);
}

// ── Hook: board tasks linked to the session ───────────────────────────────────

function useSessionPlan(sessionId: number, isActive: boolean) {
  return useQuery<SessionPlanResponse>({
    queryKey: ["session-plan", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/plan`);
      if (!res.ok) throw new Error("Failed to fetch session plan");
      return res.json() as Promise<SessionPlanResponse>;
    },
    refetchInterval: isActive ? 15_000 : 60_000,
    staleTime: 5_000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function CheckpointLines({ text }: { text: string }) {
  const lines = text
    .split(/\n|;/)
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) return <p className="text-xs text-muted-foreground">{text}</p>;

  return (
    <ul className="space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="w-3 h-3 text-emerald-500/60 shrink-0 mt-0.5" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

const STATUS_ICON: Record<PlanTaskStatus, React.ReactNode> = {
  planned: <Circle className="w-3 h-3 shrink-0 text-muted-foreground" />,
  in_progress: <Clock className="w-3 h-3 shrink-0 text-cyan-400" />,
  done: <CheckSquare className="w-3 h-3 shrink-0 text-emerald-400" />,
  partial: <AlertCircle className="w-3 h-3 shrink-0 text-amber-400" />,
  skipped: <SkipForward className="w-3 h-3 shrink-0 text-muted-foreground" />,
};

const STATUS_NEXT: Record<PlanTaskStatus, PlanTaskStatus> = {
  planned: "in_progress",
  in_progress: "done",
  done: "planned",
  partial: "done",
  skipped: "planned",
};

// ── TaskRow ───────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  planId,
  userId,
  onStatusChange,
  onView,
}: {
  task: ProjectTask;
  planId: number;
  userId: string;
  onStatusChange: (taskId: number, status: PlanTaskStatus) => void;
  onView: (task: ProjectTask) => void;
}) {
  const [saving, setSaving] = useState(false);

  const handleClick = async () => {
    if (saving) return;
    const next = STATUS_NEXT[task.status];
    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}api/plans/${planId}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, confirmedByUser: true, userId }),
      });
      if (res.ok) onStatusChange(task.id, next);
    } finally {
      setSaving(false);
    }
  };

  const isDone = task.status === "done" || task.status === "skipped";

  return (
    <div className="group flex items-start gap-2 py-1">
      <button
        onClick={handleClick}
        disabled={saving}
        className="mt-0.5 shrink-0 transition-opacity hover:opacity-70 disabled:opacity-40"
        title={`Status: ${task.status} — click to advance`}
      >
        {saving
          ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          : STATUS_ICON[task.status]}
      </button>
      <span
        className={`text-xs leading-snug flex-1 min-w-0 ${
          isDone
            ? "text-muted-foreground line-through"
            : task.status === "in_progress"
            ? "text-foreground font-medium"
            : "text-muted-foreground"
        }`}
      >
        {task.text}
      </span>
      {task.priority === "high" && (
        <span className="text-[9px] font-semibold uppercase text-amber-400 shrink-0 mt-0.5">high</span>
      )}
      <button
        onClick={() => onView(task)}
        className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
        title="View task details"
        style={{ color: "var(--accent-cyan)" }}
      >
        <Eye className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── PlanProgressStrip (board tasks) ───────────────────────────────────────────

function PlanProgressStrip({
  sessionId,
  isActive,
}: {
  sessionId: number;
  isActive: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useSessionPlan(sessionId, isActive);
  const [expanded, setExpanded] = useState(false);
  const [drawerTask, setDrawerTask] = useState<TaskDetail | null>(null);

  const handleStatusChange = useCallback(
    (taskId: number, status: PlanTaskStatus) => {
      queryClient.setQueryData<SessionPlanResponse>(
        ["session-plan", sessionId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            tasks: old.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status, completedAt: status === "done" ? new Date().toISOString() : t.completedAt }
                : t
            ),
          };
        }
      );
    },
    [queryClient, sessionId]
  );

  if (isLoading || !data || !data.plan) return null;

  const { plan, tasks } = data;
  if (tasks.length === 0) return null;

  const inProgressTasks = tasks
    .filter((t) => t.status === "in_progress" || t.status === "partial")
    .sort((a, b) => a.stepIndex - b.stepIndex);
  const doneTasks = tasks.filter((t) => t.status === "done" || t.status === "skipped");
  const plannedTasks = tasks.filter((t) => t.status === "planned");
  const totalTasks = tasks.length;
  const doneCount = doneTasks.length;
  const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;
  const currentTask = inProgressTasks[0] ?? null;

  return (
    <div className="border-t border-border/30 pt-3 space-y-2.5">
      {/* Header row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={expanded}
      >
        <ListChecks className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex-1">
          Plan Progress — {plan.title}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {inProgressTasks.length > 0 && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 h-4 bg-cyan-500/10 text-cyan-400 border-cyan-500/30 gap-1"
            >
              <Clock className="w-2 h-2" />
              {inProgressTasks.length} active
            </Badge>
          )}
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-4 bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
          >
            {doneCount}/{totalTasks}
          </Badge>
          {expanded
            ? <ChevronDown className="w-3 h-3 text-muted-foreground opacity-60" />
            : <ChevronRight className="w-3 h-3 text-muted-foreground opacity-60" />}
        </div>
      </button>

      {/* Mini progress bar */}
      <div className="h-1.5 rounded-full bg-secondary/60 overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Current in-progress task */}
      {currentTask ? (
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-cyan-400/70 mb-1">
            In Progress
          </p>
          <div className="flex items-start gap-2">
            <Clock className="w-3 h-3 text-cyan-400 shrink-0 mt-0.5" />
            <p className="text-xs text-foreground leading-snug font-medium">{currentTask.text}</p>
          </div>
        </div>
      ) : doneCount === totalTasks && totalTasks > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <CheckSquare className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-400">All tasks complete</p>
        </div>
      ) : plannedTasks.length > 0 ? (
        <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
            Next up
          </p>
          <p className="text-xs text-muted-foreground leading-snug">
            {plannedTasks.sort((a, b) => a.stepIndex - b.stepIndex)[0]?.text}
          </p>
        </div>
      ) : null}

      {/* Expandable full task list */}
      {expanded && (
        <div className="space-y-0 pt-1">
          {tasks
            .slice()
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                planId={plan.id}
                userId={plan.userId}
                onStatusChange={handleStatusChange}
                onView={(t) => setDrawerTask({ id: t.id, planId: t.planId, text: t.text, status: t.status, priority: t.priority, doneLooksLike: t.doneLooksLike, outOfScope: t.outOfScope, fileDependencies: t.fileDependencies, userId: plan.userId })}
              />
            ))}
        </div>
      )}

      {/* Show-all toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors text-center pt-0.5"
      >
        {expanded
          ? "Hide task list"
          : `Show all ${totalTasks} task${totalTasks !== 1 ? "s" : ""} · ${plannedTasks.length} planned`}
      </button>

      <TaskDetailDrawer
        task={drawerTask}
        onClose={() => setDrawerTask(null)}
      />
    </div>
  );
}

// ── PlanProgressPanel (main export) ──────────────────────────────────────────

interface PlanProgressPanelProps {
  sessionId: number;
  isActive: boolean;
}

export function PlanProgressPanel({ sessionId, isActive }: PlanProgressPanelProps) {
  const { availability, snapshot } = usePlanStatus(sessionId, isActive);

  const hasActiveTask = !!snapshot?.activeTask;
  const hasCheckpoint = !!snapshot?.planCheckpoint;
  const hasFiles = !!(snapshot?.activeFiles && snapshot.activeFiles.length > 0);
  const hasErrors = !!(snapshot?.unresolvedErrors && snapshot.unresolvedErrors.length > 0);
  const hasLiveContent = hasActiveTask || hasCheckpoint || hasFiles || hasErrors;

  const showLiveSection =
    availability !== "unavailable" &&
    availability !== "starting" &&
    snapshot != null &&
    hasLiveContent;

  const isLive = availability === "live";
  const updatedAgo = snapshot ? (() => {
    try {
      const ms = Date.now() - new Date(snapshot.updatedAt).getTime();
      if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
      if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
      return `${Math.round(ms / 3600000)}h ago`;
    } catch { return null; }
  })() : null;

  if (!showLiveSection) {
    // No live MIZI progress — render just the plan strip (if a plan is linked).
    return (
      <PlanProgressStripCard sessionId={sessionId} isActive={isActive} />
    );
  }

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          MIZI Progress
          {isLive ? (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              Live
            </Badge>
          ) : updatedAgo ? (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <Clock className="w-2.5 h-2.5" />
              {updatedAgo}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {hasActiveTask && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Active Task
            </p>
            <div className="flex items-start gap-2">
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0 mt-0.5" />
              <p className="text-sm font-medium leading-snug">{snapshot!.activeTask}</p>
            </div>
            {snapshot!.taskSummary && snapshot!.taskSummary !== snapshot!.activeTask && (
              <p className="text-xs text-muted-foreground pl-5 leading-snug">
                {snapshot!.taskSummary}
              </p>
            )}
          </div>
        )}

        {hasCheckpoint && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Plan Checkpoint
            </p>
            <CheckpointLines text={snapshot!.planCheckpoint!} />
          </div>
        )}

        {hasFiles && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Active Files
            </p>
            <ul className="space-y-0.5">
              {snapshot!.activeFiles!.slice(0, 5).map((f, i) => (
                <li key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                  <FileCode2 className="w-3 h-3 text-primary/50 shrink-0" />
                  <span className="truncate">{f}</span>
                </li>
              ))}
              {snapshot!.activeFiles!.length > 5 && (
                <li className="text-xs text-muted-foreground/60 pl-4">
                  +{snapshot!.activeFiles!.length - 5} more
                </li>
              )}
            </ul>
          </div>
        )}

        {hasErrors && (
          <div className="space-y-1 border-t border-border/30 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              Unresolved Errors
            </p>
            <ul className="space-y-1">
              {snapshot!.unresolvedErrors!.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-red-400/80">
                  <AlertCircle className="w-3 h-3 text-red-400/70 shrink-0 mt-0.5" />
                  <span className="leading-snug">{e}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Plan board strip — appended inside the same card when live MIZI data is shown */}
        <PlanProgressStrip sessionId={sessionId} isActive={isActive} />
      </CardContent>
    </Card>
  );
}

// ── Standalone card used when there is no live MIZI status ───────────────────

function PlanProgressStripCard({
  sessionId,
  isActive,
}: {
  sessionId: number;
  isActive: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useSessionPlan(sessionId, isActive);
  const [expanded, setExpanded] = useState(false);
  const [drawerTask, setDrawerTask] = useState<TaskDetail | null>(null);

  const handleStatusChange = useCallback(
    (taskId: number, status: PlanTaskStatus) => {
      queryClient.setQueryData<SessionPlanResponse>(
        ["session-plan", sessionId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            tasks: old.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status, completedAt: status === "done" ? new Date().toISOString() : t.completedAt }
                : t
            ),
          };
        }
      );
    },
    [queryClient, sessionId]
  );

  if (isLoading || !data || !data.plan || data.tasks.length === 0) return null;

  const { plan, tasks } = data;
  const inProgressTasks = tasks
    .filter((t) => t.status === "in_progress" || t.status === "partial")
    .sort((a, b) => a.stepIndex - b.stepIndex);
  const doneTasks = tasks.filter((t) => t.status === "done" || t.status === "skipped");
  const plannedTasks = tasks.filter((t) => t.status === "planned");
  const totalTasks = tasks.length;
  const doneCount = doneTasks.length;
  const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;
  const currentTask = inProgressTasks[0] ?? null;

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-2 flex-1 text-left"
            aria-expanded={expanded}
          >
            <ListChecks className="w-4 h-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-sm text-muted-foreground font-medium uppercase tracking-wide flex-1">
              Plan Progress
            </CardTitle>
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground opacity-60" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-60" />}
          </button>
          <div className="flex items-center gap-1.5 shrink-0">
            {inProgressTasks.length > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 bg-cyan-500/10 text-cyan-400 border-cyan-500/30 gap-1"
              >
                <Clock className="w-2.5 h-2.5" />
                {inProgressTasks.length} active
              </Badge>
            )}
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            >
              {doneCount}/{totalTasks} done
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Mini progress bar */}
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-secondary/60 overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="truncate pr-2">{plan.title}</span>
            <span className="shrink-0">{progressPct}%</span>
          </div>
        </div>

        {/* Current in-progress task */}
        {currentTask ? (
          <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-cyan-400/70 mb-1">
              In Progress
            </p>
            <div className="flex items-start gap-2">
              <Clock className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
              <p className="text-sm text-foreground leading-snug font-medium">{currentTask.text}</p>
            </div>
          </div>
        ) : doneCount === totalTasks && totalTasks > 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
            <CheckSquare className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-400">All tasks complete</p>
          </div>
        ) : plannedTasks.length > 0 ? (
          <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Next up
            </p>
            <p className="text-sm text-muted-foreground leading-snug">
              {plannedTasks.sort((a, b) => a.stepIndex - b.stepIndex)[0]?.text}
            </p>
          </div>
        ) : null}

        {/* Expandable full task list */}
        {expanded && (
          <div className="border-t border-border/30 pt-3 space-y-0.5">
            {tasks
              .slice()
              .sort((a, b) => a.stepIndex - b.stepIndex)
              .map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  planId={plan.id}
                  userId={plan.userId}
                  onStatusChange={handleStatusChange}
                  onView={(t) => setDrawerTask({ id: t.id, planId: t.planId, text: t.text, status: t.status, priority: t.priority, doneLooksLike: t.doneLooksLike, outOfScope: t.outOfScope, fileDependencies: t.fileDependencies, userId: plan.userId })}
                />
              ))}
          </div>
        )}

        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors text-center py-0.5"
        >
          {expanded
            ? "Hide task list"
            : `Show all ${totalTasks} task${totalTasks !== 1 ? "s" : ""} · ${plannedTasks.length} planned`}
        </button>

        <TaskDetailDrawer
          task={drawerTask}
          onClose={() => setDrawerTask(null)}
        />
      </CardContent>
    </Card>
  );
}
