import { AlertTriangle, CheckCircle2, Loader2, Radio, Wifi, WifiOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { OrchestrationStatusData, OrchestrationLaneStatus } from "@/hooks/use-orchestration-status";

// ── Boot phase ordering for the progress strip ────────────────────────────────

const BOOT_PHASE_LABELS: Record<string, string> = {
  pending: "Pending",
  provisioning: "GPU Provisioning",
  downloading: "Model Download",
  starting: "Starting Up",
  ready: "Ready",
  error: "Error",
};

const BOOT_PHASE_ORDER = ["pending", "provisioning", "downloading", "starting", "ready"];

/**
 * bootPhase: the actual phase name (e.g. "provisioning", "downloading").
 *            "error" is deliberately excluded from BOOT_PHASE_ORDER so it
 *            doesn't appear as its own step; the `failed` flag is used instead
 *            to mark the phase where provisioning broke.
 * failed:    when true, the current phase is rendered with an error icon rather
 *            than the spinner, indicating where in the sequence it failed.
 */
function BootPhaseStrip({ bootPhase, failed = false }: { bootPhase: string; failed?: boolean }) {
  // Clamp to the ordered list. If bootPhase is unknown / "error", fall back
  // to the last known phase before "ready" (provisioning) so the strip shows
  // meaningful progress rather than all-pending circles.
  const resolvedPhase = BOOT_PHASE_ORDER.includes(bootPhase) ? bootPhase : "provisioning";
  const currentIdx = BOOT_PHASE_ORDER.indexOf(resolvedPhase);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {BOOT_PHASE_ORDER.map((phase, idx) => {
        const isDone = currentIdx > idx;
        const isCurrentPhase = currentIdx === idx;
        const isErrorPhase = isCurrentPhase && failed;
        const isActive = isCurrentPhase && !failed;
        const isPending = idx > currentIdx;

        return (
          <div key={phase} className="flex items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              ) : isErrorPhase ? (
                <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
              ) : isActive ? (
                <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />
              ) : (
                <div
                  className={`w-3.5 h-3.5 rounded-full border shrink-0 ${
                    isPending
                      ? "border-muted-foreground/30 bg-transparent"
                      : "border-muted-foreground/50"
                  }`}
                />
              )}
              <span
                className={`text-xs font-medium ${
                  isDone
                    ? "text-emerald-500"
                    : isActive
                    ? "text-foreground"
                    : isErrorPhase
                    ? "text-destructive"
                    : "text-muted-foreground/50"
                }`}
              >
                {BOOT_PHASE_LABELS[phase] ?? phase}
              </span>
            </div>
            {idx < BOOT_PHASE_ORDER.length - 1 && (
              <div
                className={`w-6 h-px shrink-0 ${
                  isDone ? "bg-emerald-500/50" : "bg-border/50"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Per-lane bridge status pill ───────────────────────────────────────────────

function LanePill({ lane }: { lane: OrchestrationLaneStatus }) {
  const connected = lane.bridgeStatus === "connected";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 border text-xs ${
        connected
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : "border-border/50 bg-secondary/40 text-muted-foreground"
      }`}
    >
      {connected ? (
        <Wifi className="w-3 h-3 shrink-0" />
      ) : (
        <WifiOff className="w-3 h-3 shrink-0 animate-pulse" />
      )}
      <span className="font-medium capitalize">{lane.memberIdentifier}</span>
      <span className="opacity-60">{connected ? "connected" : "waiting"}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface OrchestrationProgressPanelProps {
  data: OrchestrationStatusData | null;
  fetchError: string | null;
}

export function OrchestrationProgressPanel({
  data,
  fetchError,
}: OrchestrationProgressPanelProps) {
  if (!data && !fetchError) {
    return (
      <Card className="border-border/50 bg-card/50">
        <CardContent className="pt-4 pb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          Fetching provisioning status…
        </CardContent>
      </Card>
    );
  }

  if (fetchError && !data) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="pt-4 pb-4 flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Could not fetch provisioning status: {fetchError}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const isReady = data.status === "ready";
  const isError = data.status === "error";

  return (
    <Card className={`border-border/50 bg-card/50 ${isError ? "border-destructive/40 bg-destructive/5" : ""}`}>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Radio className={`w-4 h-4 ${isReady ? "text-emerald-500" : isError ? "text-destructive" : "text-primary animate-pulse"}`} />
          Team Provisioning
          {isReady ? (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
            >
              Ready
            </Badge>
          ) : isError ? (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-destructive/15 text-destructive border-destructive/40"
            >
              Failed
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-primary/15 text-primary border-primary/40 gap-1"
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              Provisioning
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Boot phase strip — pass actual bootPhase + failed flag so the strip
            can highlight the correct step with an error icon instead of treating
            "error" as an unknown phase and rendering all steps as pending. */}
        <BootPhaseStrip bootPhase={data.bootPhase} failed={isError} />

        {/* Status message */}
        {data.bootMessage && !isError && (
          <p className="text-[11px] text-muted-foreground font-mono leading-relaxed break-all">
            {data.bootMessage}
          </p>
        )}

        {/* Error banner */}
        {isError && data.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-words">{data.error}</span>
          </div>
        )}

        {/* Per-lane bridge connectivity */}
        {data.lanes.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
              Lane Bridge Status
            </p>
            <div className="flex flex-wrap gap-2">
              {data.lanes.map((lane) => (
                <LanePill key={lane.laneId} lane={lane} />
              ))}
            </div>
            {!isError && (
              <p className="text-[10px] text-muted-foreground">
                {data.allLanesConnected
                  ? "All lanes connected — session is ready."
                  : `Waiting for ${data.lanes.filter((l) => l.bridgeStatus !== "connected").length} lane${data.lanes.filter((l) => l.bridgeStatus !== "connected").length !== 1 ? "s" : ""} to connect.`}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
