/**
 * ProjectPlanBoard — Task Board view with Planned / In Progress / Done columns.
 * Supports drag-drop between columns, inline text editing, manual task add,
 * and one-click export as Markdown.
 */
import { useState, useRef, useEffect } from "react";
import {
  CheckSquare, Circle, Clock, ChevronDown, ChevronRight,
  Plus, Trash2, Download, Loader2, GripVertical,
  AlertCircle, SkipForward, X, Edit2, Check,
} from "lucide-react";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanTaskStatus = "planned" | "in_progress" | "done" | "partial" | "skipped";
type PlanTaskPriority = "high" | "normal" | "low";

interface ProjectPlan {
  id: number;
  userId: string;
  repoUrl: string | null;
  title: string;
  version: number;
  lastReassessmentSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectTask {
  id: number;
  planId: number;
  stepIndex: number;
  text: string;
  status: PlanTaskStatus;
  priority: PlanTaskPriority;
  confirmedByUser: boolean;
  originPlanVersion: number | null;
  blockedBy: number[] | null;
  sessionId: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLUMNS: { key: PlanTaskStatus | "planned_and_progress"; label: string; statuses: PlanTaskStatus[] }[] = [
  { key: "planned", label: "Planned", statuses: ["planned"] },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress", "partial"] },
  { key: "done", label: "Done", statuses: ["done", "skipped"] },
];

const STATUS_NEXT: Record<PlanTaskStatus, PlanTaskStatus> = {
  planned: "in_progress",
  in_progress: "done",
  done: "planned",
  partial: "done",
  skipped: "planned",
};

const PRIORITY_COLORS: Record<PlanTaskPriority, string> = {
  high: "#f59e0b",
  normal: "var(--text-muted)",
  low: "var(--text-muted)",
};

const STATUS_ICON = {
  planned: <Circle className="w-3 h-3" />,
  in_progress: <Clock className="w-3 h-3" style={{ color: "var(--accent-cyan)" }} />,
  done: <CheckSquare className="w-3 h-3" style={{ color: "#10b981" }} />,
  partial: <AlertCircle className="w-3 h-3" style={{ color: "#f59e0b" }} />,
  skipped: <SkipForward className="w-3 h-3" style={{ color: "var(--text-muted)" }} />,
};

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onStatusChange,
  onTextChange,
  onDelete,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  onStatusChange: (taskId: number, status: PlanTaskStatus, confirmedByUser: boolean) => Promise<void>;
  onTextChange: (taskId: number, text: string) => Promise<void>;
  onDelete: (taskId: number) => Promise<void>;
  dragging: boolean;
  onDragStart: (taskId: number) => void;
  onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStatusCycle = async () => {
    const next = STATUS_NEXT[task.status];
    setSaving(true);
    try {
      await onStatusChange(task.id, next, true);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveText = async () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === task.text) { setEditing(false); return; }
    setSaving(true);
    try {
      await onTextChange(task.id, trimmed);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  return (
    <div
      draggable
      onDragStart={() => onDragStart(task.id)}
      onDragEnd={onDragEnd}
      className="rounded-xl p-3 space-y-2 transition-all"
      style={{
        background: dragging ? "rgba(0,180,216,0.08)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${dragging ? "rgba(0,180,216,0.22)" : "var(--border-glass-soft)"}`,
        opacity: dragging ? 0.6 : 1,
        cursor: "grab",
      }}
    >
      <div className="flex items-start gap-2">
        {/* Grip */}
        <GripVertical className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-20" />

        {/* Status toggle */}
        <button
          onClick={handleStatusCycle}
          disabled={saving}
          className="shrink-0 mt-0.5 transition-opacity hover:opacity-70"
          title={`Status: ${task.status} — click to advance`}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : STATUS_ICON[task.status]}
        </button>

        {/* Text */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <textarea
              ref={inputRef}
              value={editText}
              onChange={e => setEditText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSaveText(); }
                if (e.key === "Escape") { setEditing(false); setEditText(task.text); }
              }}
              rows={2}
              className="w-full text-xs bg-transparent outline-none resize-none"
              style={{ color: "var(--text-primary)" }}
            />
          ) : (
            <p
              className="text-xs leading-snug"
              style={{
                color: task.status === "done" || task.status === "skipped" ? "var(--text-muted)" : "var(--text-primary)",
                textDecoration: task.status === "done" ? "line-through" : "none",
              }}
            >
              {task.text}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <button onClick={handleSaveText} className="text-emerald-400 hover:text-emerald-300 transition-colors">
                <Check className="w-3 h-3" />
              </button>
              <button onClick={() => { setEditing(false); setEditText(task.text); }} className="transition-colors" style={{ color: "var(--text-muted)" }}>
                <X className="w-3 h-3" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                <Edit2 className="w-3 h-3" />
              </button>
              {task.status !== "skipped" && (
                <button
                  onClick={() => { void onStatusChange(task.id, "skipped", true); }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: "var(--text-muted)" }}
                  title="Mark as skipped"
                  onMouseEnter={e => (e.currentTarget.style.color = "#f59e0b")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                >
                  <SkipForward className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => { void onDelete(task.id); }}
                className="transition-colors"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 pl-7">
        {task.priority !== "normal" && (
          <span className="text-[9px] font-semibold uppercase" style={{ color: PRIORITY_COLORS[task.priority] }}>
            {task.priority}
          </span>
        )}
        {task.confirmedByUser && (
          <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>confirmed</span>
        )}
        {task.originPlanVersion != null && (
          <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            v{task.originPlanVersion}
          </span>
        )}
        {task.sessionId && (
          <a
            href={`/sessions/${task.sessionId}`}
            className="text-[9px] font-mono underline-offset-2 hover:underline"
            style={{ color: "var(--accent-cyan)" }}
            title={`View session #${task.sessionId}`}
          >
            session #{task.sessionId}
          </a>
        )}
        {task.completedAt && (
          <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
            done {new Date(task.completedAt).toLocaleDateString()}
          </span>
        )}
        {task.blockedBy && task.blockedBy.length > 0 && (
          <span className="text-[9px]" style={{ color: "#f59e0b" }}>
            blocked by #{task.blockedBy.join(", #")}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────────

function Column({
  label,
  tasks,
  onDrop,
  onStatusChange,
  onTextChange,
  onDelete,
  draggedId,
  onDragStart,
  onDragEnd,
  targetStatuses,
}: {
  label: string;
  tasks: ProjectTask[];
  onDrop: (taskId: number, targetStatus: PlanTaskStatus) => Promise<void>;
  onStatusChange: (taskId: number, status: PlanTaskStatus, confirmedByUser: boolean) => Promise<void>;
  onTextChange: (taskId: number, text: string) => Promise<void>;
  onDelete: (taskId: number) => Promise<void>;
  draggedId: number | null;
  onDragStart: (taskId: number) => void;
  onDragEnd: () => void;
  targetStatuses: PlanTaskStatus[];
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className="flex-1 min-w-[200px] rounded-2xl p-3 space-y-2 transition-all"
      style={{
        background: dragOver ? "rgba(0,180,216,0.04)" : "rgba(255,255,255,0.015)",
        border: `1px solid ${dragOver ? "rgba(0,180,216,0.18)" : "var(--border-glass-soft)"}`,
        minHeight: "120px",
      }}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        if (draggedId !== null) {
          const targetStatus = targetStatuses[0]!;
          void onDrop(draggedId, targetStatus);
        }
      }}
    >
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
        <span
          className="text-[10px] font-mono rounded-full px-1.5 py-0.5"
          style={{ background: "rgba(255,255,255,0.04)", color: "var(--text-muted)" }}
        >
          {tasks.length}
        </span>
      </div>

      <div className="group space-y-2">
        {tasks.sort((a, b) => a.stepIndex - b.stepIndex).map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onStatusChange={onStatusChange}
            onTextChange={onTextChange}
            onDelete={onDelete}
            dragging={draggedId === task.id}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>

      {tasks.length === 0 && !dragOver && (
        <p className="text-center text-[11px] py-4" style={{ color: "var(--text-muted)", opacity: 0.4 }}>
          Drop tasks here
        </p>
      )}
    </div>
  );
}

// ── AddTaskRow ────────────────────────────────────────────────────────────────

function AddTaskRow({ planId, userId, onAdded }: { planId: number; userId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<PlanTaskPriority>("normal");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await fetch(`${BASE_URL}api/plans/${planId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), priority, userId }),
      });
      setText("");
      setOpen(false);
      onAdded();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-xs transition-colors py-1"
        style={{ color: "var(--text-muted)" }}
        onMouseEnter={e => (e.currentTarget.style.color = "var(--accent-cyan)")}
        onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
      >
        <Plus className="w-3.5 h-3.5" />
        Add task
      </button>
    );
  }

  return (
    <div
      className="rounded-xl p-3 space-y-2"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-glass-soft)" }}
    >
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleAdd(); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Describe the task…"
        rows={2}
        className="w-full text-xs bg-transparent outline-none resize-none"
        style={{ color: "var(--text-primary)" }}
      />
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {(["normal", "high", "low"] as PlanTaskPriority[]).map(p => (
            <button
              key={p}
              onClick={() => setPriority(p)}
              className="text-[10px] px-2 py-0.5 rounded-md transition-all"
              style={{
                background: priority === p ? "rgba(0,180,216,0.1)" : "rgba(255,255,255,0.03)",
                color: priority === p ? "var(--accent-cyan)" : "var(--text-muted)",
                border: `1px solid ${priority === p ? "rgba(0,180,216,0.2)" : "var(--border-glass)"}`,
              }}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setOpen(false)}
          className="text-xs transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          Cancel
        </button>
        <button
          onClick={() => { void handleAdd(); }}
          disabled={!text.trim() || saving}
          className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg transition-all disabled:opacity-40"
          style={{
            background: "rgba(0,180,216,0.1)",
            color: "var(--accent-cyan)",
            border: "1px solid rgba(0,180,216,0.2)",
          }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Add
        </button>
      </div>
    </div>
  );
}

// ── ProjectPlanBoard ──────────────────────────────────────────────────────────

export function ProjectPlanBoard({ userId, repoUrl }: { userId: string; repoUrl?: string | null }) {
  const [plans, setPlans] = useState<(ProjectPlan & { taskCount: number; doneCount: number })[]>([]);
  const [activePlanId, setActivePlanId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [exporting, setExporting] = useState(false);

  const fetchPlans = async () => {
    try {
      const url = new URL(`${BASE_URL}api/plans`);
      url.searchParams.set("userId", userId);
      if (repoUrl) url.searchParams.set("repoUrl", repoUrl);
      const r = await fetch(url.toString());
      if (!r.ok) return;
      const data = await r.json() as (ProjectPlan & { taskCount: number; doneCount: number })[];
      setPlans(data);
      if (data.length > 0 && !activePlanId) {
        setActivePlanId(data[0]!.id);
      }
    } catch { /* ignore */ }
  };

  const fetchTasks = async (planId: number) => {
    try {
      const r = await fetch(`${BASE_URL}api/plans/${planId}?userId=${encodeURIComponent(userId)}`);
      if (!r.ok) return;
      const data = await r.json() as { plan: ProjectPlan; tasks: ProjectTask[] };
      setTasks(data.tasks);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    setLoading(true);
    fetchPlans().finally(() => setLoading(false));
  }, [userId, repoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activePlanId) {
      void fetchTasks(activePlanId);
    }
  }, [activePlanId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 30 s so post-session reassessment results surface without a manual reload.
  useEffect(() => {
    const id = setInterval(() => {
      if (activePlanId) void fetchTasks(activePlanId);
      void fetchPlans();
    }, 30_000);
    return () => clearInterval(id);
  }, [activePlanId, userId, repoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    if (activePlanId) void fetchTasks(activePlanId);
    void fetchPlans();
  };

  const handleStatusChange = async (taskId: number, status: PlanTaskStatus, confirmedByUser: boolean) => {
    if (!activePlanId) return;
    await fetch(`${BASE_URL}api/plans/${activePlanId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, confirmedByUser, userId }),
    });
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, confirmedByUser, completedAt: status === "done" ? new Date().toISOString() : t.completedAt } : t));
  };

  const handleTextChange = async (taskId: number, text: string) => {
    if (!activePlanId) return;
    await fetch(`${BASE_URL}api/plans/${activePlanId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, userId }),
    });
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, text } : t));
  };

  const handleDelete = async (taskId: number) => {
    if (!activePlanId) return;
    await fetch(`${BASE_URL}api/plans/${activePlanId}/tasks/${taskId}?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    setTasks(prev => prev.filter(t => t.id !== taskId));
    void fetchPlans();
  };

  const handleDrop = async (taskId: number, targetStatus: PlanTaskStatus) => {
    setDraggedId(null);
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === targetStatus) return;
    await handleStatusChange(taskId, targetStatus, true);
  };

  const handleExport = async () => {
    if (!activePlanId) return;
    setExporting(true);
    try {
      const r = await fetch(`${BASE_URL}api/plans/${activePlanId}/export?userId=${encodeURIComponent(userId)}`);
      if (!r.ok) return;
      const text = await r.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `plan-${activePlanId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const activePlan = plans.find(p => p.id === activePlanId);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 px-2" style={{ color: "var(--text-muted)" }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-xs">Loading project plan…</span>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div
        className="rounded-2xl px-5 py-4"
        style={{
          background: "rgba(255,255,255,0.018)",
          border: "1px dashed var(--border-glass-soft)",
        }}
      >
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          No project plan yet. Type your intent above and click <strong>Plan it</strong> to generate one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-2 text-xs font-semibold flex-1 transition-colors"
          style={{ color: "var(--text-secondary)" }}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 opacity-50" /> : <ChevronRight className="w-3.5 h-3.5 opacity-50" />}
          Project Plan
          {activePlan && (
            <span className="text-[10px] font-normal" style={{ color: "var(--text-muted)" }}>
              — {activePlan.title}
            </span>
          )}
        </button>

        {/* Plan picker (multiple plans) */}
        {plans.length > 1 && (
          <select
            value={activePlanId ?? ""}
            onChange={e => setActivePlanId(Number(e.target.value))}
            className="text-[11px] bg-transparent outline-none rounded-lg px-2 py-1"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-glass)" }}
          >
            {plans.map(p => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        )}

        {/* Export */}
        {activePlanId && (
          <button
            onClick={() => { void handleExport(); }}
            disabled={exporting}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg transition-all"
            style={{
              color: "var(--text-muted)",
              border: "1px solid var(--border-glass)",
              background: "rgba(255,255,255,0.02)",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            Export
          </button>
        )}
      </div>

      {/* Board */}
      {expanded && activePlanId && (
        <div className="space-y-3">
          {/* Last reassessment summary — surfaces after a session completes */}
          {activePlan && activePlan.lastReassessmentSummary && (
            <div
              className="rounded-xl px-3 py-2 flex items-start gap-2"
              style={{
                background: "rgba(16,185,129,0.06)",
                border: "1px solid rgba(16,185,129,0.14)",
              }}
            >
              <span className="text-[10px] mt-0.5 shrink-0" style={{ color: "#10b981" }}>↺</span>
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                <span className="font-semibold" style={{ color: "#10b981" }}>Last reassessment: </span>
                {activePlan.lastReassessmentSummary}
              </p>
            </div>
          )}

          {/* Progress bar — derived from live tasks state so it updates immediately after status edits */}
          {activePlan && tasks.length > 0 && (() => {
            const liveTotal = tasks.length;
            const liveDone = tasks.filter(t => t.status === "done" || t.status === "skipped").length;
            return (
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 h-1 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round((liveDone / liveTotal) * 100)}%`,
                      background: "linear-gradient(90deg, #10b981, var(--accent-cyan))",
                    }}
                  />
                </div>
                <span className="text-[10px] shrink-0" style={{ color: "var(--text-muted)" }}>
                  {liveDone}/{liveTotal}
                </span>
              </div>
            );
          })()}

          {/* Columns */}
          <div className="flex gap-3 overflow-x-auto pb-1">
            {STATUS_COLUMNS.map(col => (
              <Column
                key={col.key}
                label={col.label}
                tasks={tasks.filter(t => col.statuses.includes(t.status))}
                onDrop={handleDrop}
                onStatusChange={handleStatusChange}
                onTextChange={handleTextChange}
                onDelete={handleDelete}
                draggedId={draggedId}
                onDragStart={setDraggedId}
                onDragEnd={() => setDraggedId(null)}
                targetStatuses={col.statuses}
              />
            ))}
          </div>

          {/* Add task */}
          <AddTaskRow planId={activePlanId} userId={userId} onAdded={refresh} />
        </div>
      )}
    </div>
  );
}
