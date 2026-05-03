import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Circle, XCircle, ChevronDown, ChevronRight, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BootPhase } from "@/lib/boot-phases";

interface BootTimelineProps {
  phases: BootPhase[];
  /** Wall-clock time the session was created — used to drive the elapsed counter. */
  startedAt: Date | null;
  /** Profile-derived "usually X-Y min" hint shown beneath the timeline. */
  estimateMinutes?: number | null;
  /** Active phase's raw status message, displayed in muted monospace. */
  rawStatusMessage?: string | null;
  /** Full accumulated boot log lines, shown in collapsible expander. */
  bootLog: string[];
  /** When set, renders a Destroy & Retry CTA in the disk-full warning banner. */
  diskFullAction?: { onRetry: () => void; isRetrying: boolean };
}

function PhaseIcon({ status }: { status: BootPhase["status"] }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
  if (status === "active") return <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />;
  if (status === "error") return <XCircle className="w-4 h-4 text-destructive shrink-0" />;
  if (status === "skipped") return <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0" />;
  return <Circle className="w-4 h-4 text-muted-foreground/60 shrink-0" />;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

export function BootTimeline({
  phases,
  startedAt,
  estimateMinutes,
  rawStatusMessage,
  bootLog,
  diskFullAction,
}: BootTimelineProps) {
  const [now, setNow] = useState(() => Date.now());
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = startedAt ? now - startedAt.getTime() : 0;
  const activeIdx = phases.findIndex(p => p.status === "active" || p.status === "error");
  const diskFullDetected = bootLog.some(l => l.toLowerCase().includes("no space left on device"));

  return (
    <div className="bg-secondary/30 border border-secondary rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-secondary/60 text-xs text-muted-foreground/70 uppercase tracking-wider">
        <span className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          Boot Timeline
        </span>
        {startedAt && (
          <span className="flex items-center gap-1.5 font-mono normal-case tracking-normal text-[11px]">
            <Clock className="w-3 h-3" />
            {formatElapsed(elapsed)} elapsed
          </span>
        )}
      </div>

      <ol className="px-4 py-3 space-y-2.5" data-testid="boot-timeline">
        {phases.map((p, i) => {
          const isActive = p.status === "active";
          const isError = p.status === "error";
          return (
            <li
              key={p.key}
              className="flex items-start gap-2.5"
              data-testid={`boot-phase-${p.key}`}
              data-phase-status={p.status}
            >
              <div className="flex flex-col items-center pt-0.5">
                <PhaseIcon status={p.status} />
                {i < phases.length - 1 && (
                  <span
                    className={`w-px flex-1 mt-1 ${
                      p.status === "done" ? "bg-emerald-500/40" : "bg-border/50"
                    }`}
                    style={{ minHeight: "10px" }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0 -mt-0.5">
                <div
                  className={`text-sm leading-snug ${
                    isActive
                      ? "text-foreground font-medium"
                      : p.status === "done"
                      ? "text-foreground/80"
                      : p.status === "skipped"
                      ? "text-muted-foreground/50 italic"
                      : isError
                      ? "text-destructive font-medium"
                      : "text-muted-foreground"
                  }`}
                >
                  {p.label}
                  {isActive && <span className="ml-2 inline-flex w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
                </div>
                {(isActive || isError) && rawStatusMessage && i === activeIdx && (
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/80 break-all">
                    {">"} {rawStatusMessage}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {diskFullDetected && diskFullAction && (
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
            onClick={diskFullAction.onRetry}
            disabled={diskFullAction.isRetrying}
          >
            {diskFullAction.isRetrying ? "Retrying…" : "Destroy & Retry"}
          </Button>
        </div>
      )}

      <div className="px-4 py-2 border-t border-secondary/60 flex items-center justify-between gap-3 text-[11px] text-muted-foreground/80">
        <span>
          {estimateMinutes
            ? `Usually ~${estimateMinutes} min for this profile`
            : "Boot time varies by GPU profile"}
        </span>
        {bootLog.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => setLogOpen(o => !o)}
            data-testid="button-toggle-boot-log"
          >
            {logOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {logOpen ? "Hide" : "Show"} full boot log ({bootLog.length})
          </button>
        )}
      </div>

      {logOpen && bootLog.length > 0 && (
        <div className="border-t border-secondary/60 px-4 py-3 font-mono text-[11px] space-y-0.5 max-h-48 overflow-y-auto bg-background/40">
          {bootLog.map((line, i) => (
            <div
              key={i}
              className={i === bootLog.length - 1 ? "text-foreground" : "text-muted-foreground opacity-70"}
            >
              <span className="text-primary/50 mr-2 select-none">›</span>{line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface BootProgressStripProps {
  phases: BootPhase[];
}

/**
 * Compact horizontal progress strip for the cockpit tab bar — visible while
 * the session is still booting so users can glance at progress regardless of
 * which tab they have open. Hidden once status reaches `ready`/`stopped`/`error`.
 */
export function BootProgressStrip({ phases }: BootProgressStripProps) {
  const total = phases.length;
  const done = phases.filter(p => p.status === "done").length;
  const activeIdx = phases.findIndex(p => p.status === "active");
  const errorIdx = phases.findIndex(p => p.status === "error");
  const currentIdx = errorIdx >= 0 ? errorIdx : activeIdx;
  const currentLabel = currentIdx >= 0 ? phases[currentIdx].label : "Booting";
  const stepNum = currentIdx >= 0 ? currentIdx + 1 : done + 1;
  const pct = Math.round((done / total) * 100);

  return (
    <div className="border-b border-border/40 bg-secondary/20 px-4 py-1.5 flex items-center gap-3 text-[11px]" data-testid="boot-progress-strip">
      <span className="text-muted-foreground font-medium shrink-0">
        Booting · step {Math.min(stepNum, total)} of {total}
      </span>
      <span className="text-foreground/80 truncate flex-1 min-w-0">{currentLabel}</span>
      <div className="h-1 w-32 bg-secondary rounded-full overflow-hidden shrink-0">
        <div
          className={`h-full rounded-full transition-all duration-500 ${errorIdx >= 0 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
