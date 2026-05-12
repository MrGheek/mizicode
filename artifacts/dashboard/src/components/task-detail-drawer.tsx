import { useState, useEffect, useRef } from "react";
import { X, CheckCircle2, XCircle, FileCode2, Loader2 } from "lucide-react";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

export interface TaskDetail {
  id: number;
  planId: number;
  text: string;
  status: string;
  priority: string;
  doneLooksLike: string | null;
  outOfScope: string | null;
  fileDependencies: string | null;
  userId: string;
}

interface TaskDetailDrawerProps {
  task: TaskDetail | null;
  onClose: () => void;
  onUpdated?: (taskId: number, patch: Partial<Pick<TaskDetail, "doneLooksLike" | "outOfScope" | "fileDependencies">>) => void;
}

function SectionEditor({
  label,
  icon,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  placeholder: string;
  onSave: (val: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(ref.current.value.length, ref.current.value.length);
    }
  }, [editing]);

  const handleSave = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const lines = value
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {icon}
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          {label}
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto text-[10px] transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-cyan)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { void handleSave(); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setEditing(false); setDraft(value); }
            }}
            rows={4}
            placeholder={placeholder}
            className="w-full text-xs rounded-lg px-3 py-2 outline-none resize-none"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(0,180,216,0.25)",
              color: "var(--text-primary)",
            }}
          />
          <div className="flex gap-2 justify-end items-center">
            {saving && <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--text-muted)" }} />}
            <button
              onClick={() => { setEditing(false); setDraft(value); }}
              className="text-[11px] px-3 py-1 rounded-lg transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              Cancel
            </button>
            <button
              onMouseDown={(e) => { e.preventDefault(); void handleSave(); }}
              disabled={saving}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-lg transition-all disabled:opacity-40"
              style={{
                background: "rgba(0,180,216,0.1)",
                color: "var(--accent-cyan)",
                border: "1px solid rgba(0,180,216,0.2)",
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : lines.length > 0 ? (
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              <span className="w-1 h-1 rounded-full mt-1.5 shrink-0" style={{ background: "var(--accent-cyan)", opacity: 0.6 }} />
              <span className="leading-snug">{line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-xs italic transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          {placeholder} — click to add
        </button>
      )}
    </div>
  );
}

function FileDepsSection({
  value,
  onSave,
}: {
  value: string;
  onSave: (val: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  const handleSave = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); setEditing(false); }
    finally { setSaving(false); }
  };

  const files = value
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileCode2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          File / Task Dependencies
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto text-[10px] transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-cyan)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { void handleSave(); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setEditing(false); setDraft(value); }
            }}
            rows={4}
            placeholder={"src/components/Foo.tsx\nSome other task name"}
            className="w-full text-xs rounded-lg px-3 py-2 outline-none resize-none font-mono"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(0,180,216,0.25)",
              color: "var(--text-primary)",
            }}
          />
          <div className="flex gap-2 justify-end items-center">
            {saving && <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--text-muted)" }} />}
            <button
              onClick={() => { setEditing(false); setDraft(value); }}
              className="text-[11px] px-3 py-1 rounded-lg transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              Cancel
            </button>
            <button
              onMouseDown={(e) => { e.preventDefault(); void handleSave(); }}
              disabled={saving}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-lg transition-all disabled:opacity-40"
              style={{
                background: "rgba(0,180,216,0.1)",
                color: "var(--accent-cyan)",
                border: "1px solid rgba(0,180,216,0.2)",
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : files.length > 0 ? (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-1.5 text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
              <FileCode2 className="w-3 h-3 shrink-0" style={{ color: "var(--accent-cyan)", opacity: 0.5 }} />
              <span className="truncate">{f}</span>
            </li>
          ))}
        </ul>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-xs italic transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          No dependencies listed — click to add
        </button>
      )}
    </div>
  );
}

export function TaskDetailDrawer({ task, onClose, onUpdated }: TaskDetailDrawerProps) {
  const [localTask, setLocalTask] = useState<TaskDetail | null>(task);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalTask(task);
  }, [task]);

  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!localTask) return null;

  const patchField = async (field: "doneLooksLike" | "outOfScope" | "fileDependencies", value: string) => {
    const body: Record<string, string | null> = { userId: localTask.userId };
    body[field] = value;
    setSaveError(null);
    const res = await fetch(`${BASE_URL}api/plans/${localTask.planId}/tasks/${localTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setSaveError(`Save failed (${res.status})`);
      return;
    }
    const patch = { [field]: value } as Partial<Pick<TaskDetail, "doneLooksLike" | "outOfScope" | "fileDependencies">>;
    setLocalTask((prev) => prev ? { ...prev, ...patch } : prev);
    onUpdated?.(localTask.id, patch);
  };

  const STATUS_COLOR: Record<string, string> = {
    done: "#10b981",
    in_progress: "var(--accent-cyan)",
    partial: "#f59e0b",
    skipped: "var(--text-muted)",
    planned: "var(--text-muted)",
  };

  return (
    <>
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col overflow-hidden"
        style={{
          width: "clamp(320px, 38vw, 520px)",
          background: "var(--bg-surface, #0f1117)",
          borderLeft: "1px solid var(--border-glass-soft)",
          boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-start gap-3 px-5 py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--border-glass-soft)" }}
        >
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: STATUS_COLOR[localTask.status] ?? "var(--text-muted)" }}
              >
                {localTask.status.replace("_", " ")}
              </span>
              {localTask.priority !== "normal" && (
                <span
                  className="text-[10px] font-semibold uppercase"
                  style={{ color: localTask.priority === "high" ? "#f59e0b" : "var(--text-muted)" }}
                >
                  · {localTask.priority}
                </span>
              )}
            </div>
            <p className="text-sm font-semibold leading-snug" style={{ color: "var(--text-primary)" }}>
              {localTask.text}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 mt-0.5 transition-opacity hover:opacity-70"
            style={{ color: "var(--text-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          <SectionEditor
            label="Done looks like"
            icon={<CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />}
            value={localTask.doneLooksLike ?? ""}
            placeholder="Observable outcomes when this task is complete"
            onSave={(val) => patchField("doneLooksLike", val)}
          />

          <div style={{ borderTop: "1px solid var(--border-glass-soft)" }} />

          <SectionEditor
            label="Out of scope"
            icon={<XCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />}
            value={localTask.outOfScope ?? ""}
            placeholder="What this task does NOT cover"
            onSave={(val) => patchField("outOfScope", val)}
          />

          <div style={{ borderTop: "1px solid var(--border-glass-soft)" }} />

          <FileDepsSection
            value={localTask.fileDependencies ?? ""}
            onSave={(val) => patchField("fileDependencies", val)}
          />
        </div>

        {/* Footer hint */}
        <div
          className="px-5 py-3 shrink-0 text-[10px]"
          style={{
            borderTop: "1px solid var(--border-glass-soft)",
            color: saveError ? "#f87171" : "var(--text-muted)",
          }}
        >
          {saveError ?? "Changes are saved automatically · Press Esc to close"}
        </div>
      </div>
    </>
  );
}
