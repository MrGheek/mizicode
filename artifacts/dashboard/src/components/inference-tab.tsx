import { useState, useEffect, useCallback } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Zap, ArrowRight, Clock, Route, RouteOff, BarChart3, RefreshCw } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-url";

type SessionPhase = "explore" | "plan" | "implement" | "swarm" | "synthesise" | "review";
type ThroughputClass = "high" | "standard" | "economy";
type RoutingMode = "auto" | "pinned";

interface ModelSwitch {
  id: number;
  sessionId: number;
  fromModelId: string | null;
  fromProvider: string | null;
  toModelId: string;
  toProvider: string;
  phase: string | null;
  triggeredBy: "manual" | "auto";
  reason: string | null;
  switchedAt: string;
  durationMs: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
}

interface CostSplitEntry {
  modelId: string;
  provider: string;
  estimatedCostUsd: number;
  estimatedTokens: number;
}

interface ModelHistoryResponse {
  sessionId: number;
  currentModelId: string | null;
  currentProvider: string | null;
  currentPhase: string | null;
  modelRoutingMode: RoutingMode;
  switches: ModelSwitch[];
  costSplit: CostSplitEntry[];
  totalEstimatedCostUsd: number;
  totalEstimatedTokens: number;
}

interface RankedModel {
  nimModelId: string;
  displayName: string;
  provider: string;
  latencyMs: number | null;
  score: number;
  qualityComponent: number;
  costComponent: number;
  throughputComponent: number;
  sweBenchScore: number | null;
  throughputClass: ThroughputClass | null;
}

interface InferenceRankingResponse {
  phase: string;
  ranked: RankedModel[];
}

const PHASE_LABELS: Record<SessionPhase, string> = {
  explore:    "Explore",
  plan:       "Plan",
  implement:  "Implement",
  swarm:      "Swarm",
  synthesise: "Synthesise",
  review:     "Review",
};

const PHASE_DESCRIPTIONS: Record<SessionPhase, string> = {
  explore:    "Deep understanding — quality-first",
  plan:       "Architecture & design — quality-balanced",
  implement:  "Code changes — balanced throughput",
  swarm:      "Parallel work — throughput-first",
  synthesise: "Merge & finalise — quality returns",
  review:     "Review & polish — cost-aware",
};

const THROUGHPUT_COLORS: Record<ThroughputClass, string> = {
  high:     "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  standard: "text-blue-400 border-blue-500/40 bg-blue-500/10",
  economy:  "text-amber-400 border-amber-500/40 bg-amber-500/10",
};

function shortModelName(id: string | null): string {
  if (!id) return "—";
  return id.split("/").pop() ?? id;
}

function providerLabel(provider: string | null): string {
  if (!provider) return "";
  const map: Record<string, string> = {
    nvidia:    "NVIDIA",
    vultr:     "Vultr",
    together:  "Together AI",
    deepinfra: "DeepInfra",
  };
  return map[provider] ?? provider;
}

export function InferenceTab({
  sessionId,
  isNimSession,
  isActive,
  ownerToken,
}: {
  sessionId: number;
  isNimSession: boolean;
  isActive: boolean;
  ownerToken?: string | null;
}) {
  const { toast } = useToast();
  const [history, setHistory] = useState<ModelHistoryResponse | null>(null);
  const [ranking, setRanking] = useState<InferenceRankingResponse | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingRanking, setLoadingRanking] = useState(false);
  const [switchingModel, setSwitchingModel] = useState<string | null>(null);
  const [togglingMode, setTogglingMode] = useState(false);
  const [settingPhase, setSettingPhase] = useState<string | null>(null);

  const PHASES: SessionPhase[] = ["explore", "plan", "implement", "swarm", "synthesise", "review"];

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}api/sessions/${sessionId}/model-history`);
      if (r.ok) setHistory(await r.json() as ModelHistoryResponse);
    } catch {}
    setLoadingHistory(false);
  }, [sessionId]);

  const fetchRanking = useCallback(async () => {
    setLoadingRanking(true);
    try {
      const r = await fetch(`${API_BASE_URL}api/sessions/${sessionId}/inference-ranking`);
      if (r.ok) setRanking(await r.json() as InferenceRankingResponse);
    } catch {}
    setLoadingRanking(false);
  }, [sessionId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const authHeaders = (ownerToken: string | null | undefined): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
  });

  const handlePhaseChange = async (phase: SessionPhase) => {
    setSettingPhase(phase);
    try {
      const r = await fetch(`${API_BASE_URL}api/sessions/${sessionId}/phase`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ phase }),
      });
      if (!r.ok) throw new Error("Failed to update phase");
      const data = await r.json() as {
        ok: boolean;
        phase: string;
        autoSwitched?: { modelId: string; provider: string } | null;
        suggestion?: { modelId: string; provider: string } | null;
      };
      await fetchHistory();
      if (data.autoSwitched) {
        toast({
          title: `Phase → ${PHASE_LABELS[phase as SessionPhase]} · Model auto-switched`,
          description: `Now using ${shortModelName(data.autoSwitched.modelId)}`,
        });
      } else if (data.suggestion) {
        toast({
          title: `Phase set to ${PHASE_LABELS[phase as SessionPhase]}`,
          description: `Better model available: ${shortModelName(data.suggestion.modelId)}`,
          action: (
            <button
              className="text-xs font-medium text-primary underline underline-offset-2"
              onClick={() => handleModelSwitch(data.suggestion!.modelId, data.suggestion!.provider, "auto")}
            >
              Switch
            </button>
          ),
        });
      } else {
        toast({ title: `Phase set to ${PHASE_LABELS[phase as SessionPhase]}` });
      }
    } catch {
      toast({ title: "Failed to update phase", variant: "destructive" });
    }
    setSettingPhase(null);
  };

  const handleModelSwitch = async (modelId: string, provider: string, triggeredBy: "manual" | "auto" = "manual") => {
    setSwitchingModel(modelId);
    try {
      const r = await fetch(`${API_BASE_URL}api/sessions/${sessionId}/model`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ modelId, provider, triggeredBy }),
      });
      if (!r.ok) throw new Error("Failed to switch model");
      await fetchHistory();
      toast({
        title: "Model switched",
        description: `Now using ${shortModelName(modelId)} via ${providerLabel(provider)}`,
      });
    } catch {
      toast({ title: "Failed to switch model", variant: "destructive" });
    }
    setSwitchingModel(null);
  };

  const handleRoutingModeToggle = async () => {
    if (!history) return;
    const next: RoutingMode = history.modelRoutingMode === "auto" ? "pinned" : "auto";
    setTogglingMode(true);
    try {
      const r = await fetch(`${API_BASE_URL}api/sessions/${sessionId}/routing-mode`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ mode: next }),
      });
      if (!r.ok) throw new Error("Failed to update routing mode");
      await fetchHistory();
      toast({ title: next === "auto" ? "Auto routing enabled" : "Model pinned" });
    } catch {
      toast({ title: "Failed to update routing mode", variant: "destructive" });
    }
    setTogglingMode(false);
  };

  if (!isNimSession) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        Phase-aware model routing is only available for NIM sessions.
      </div>
    );
  }

  if (loadingHistory) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentPhase = history?.currentPhase as SessionPhase | null;
  const routingMode = history?.modelRoutingMode ?? "auto";

  return (
    <div className="space-y-4">
      {/* Current state strip */}
      <Card className="border-border/50 bg-card/50">
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-semibold">Active Model</span>
            </div>
            {isActive && (
              <button
                onClick={handleRoutingModeToggle}
                disabled={togglingMode}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium transition-colors ${
                  routingMode === "auto"
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                    : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {togglingMode ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : routingMode === "auto" ? (
                  <Route className="w-3 h-3" />
                ) : (
                  <RouteOff className="w-3 h-3" />
                )}
                {routingMode === "auto" ? "Auto routing" : "Pinned"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-mono text-emerald-300">
              {shortModelName(history?.currentModelId ?? null)}
            </code>
            {history?.currentProvider && (
              <span className="text-[10px] text-muted-foreground border border-border/40 rounded px-1.5 py-0.5">
                {providerLabel(history.currentProvider)}
              </span>
            )}
            {currentPhase && (
              <span className="text-[10px] text-primary border border-primary/30 bg-primary/5 rounded px-1.5 py-0.5">
                {PHASE_LABELS[currentPhase]} phase
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Phase selector */}
      {isActive && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              Reasoning Phase
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              {PHASES.map((phase) => (
                <button
                  key={phase}
                  onClick={() => handlePhaseChange(phase)}
                  disabled={settingPhase !== null}
                  className={`text-left rounded-lg border px-3 py-2 transition-all ${
                    currentPhase === phase
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/40 text-muted-foreground hover:border-border/70 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium">{PHASE_LABELS[phase]}</span>
                    {settingPhase === phase && (
                      <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                    {PHASE_DESCRIPTIONS[phase]}
                  </p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Model ranking */}
      {isActive && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Route className="w-4 h-4 text-muted-foreground" />
                Model Ranking {ranking && <span className="text-[10px] font-normal text-muted-foreground">for {PHASE_LABELS[ranking.phase as SessionPhase] ?? ranking.phase}</span>}
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={fetchRanking}
                disabled={loadingRanking}
              >
                {loadingRanking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Score
              </Button>
            </div>
          </CardHeader>
          {ranking && (
            <CardContent className="px-4 pb-4 space-y-1.5">
              {ranking.ranked.slice(0, 6).map((m, i) => {
                const isCurrent = m.nimModelId === history?.currentModelId;
                return (
                  <div
                    key={m.nimModelId}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
                      isCurrent ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/30 bg-secondary/20"
                    }`}
                  >
                    <span className={`text-[10px] font-mono w-4 shrink-0 ${i === 0 ? "text-primary" : "text-muted-foreground"}`}>
                      #{i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium truncate">{m.displayName}</span>
                        {m.throughputClass && (
                          <span className={`text-[9px] font-medium px-1 py-0 rounded border ${THROUGHPUT_COLORS[m.throughputClass]}`}>
                            {m.throughputClass}
                          </span>
                        )}
                        {m.sweBenchScore && (
                          <span className="text-[9px] text-muted-foreground">{m.sweBenchScore}% SWE</span>
                        )}
                      </div>
                      <div className="flex gap-2 mt-0.5">
                        <span className="text-[9px] text-muted-foreground">Score: {(m.score * 100).toFixed(1)}</span>
                        <span className="text-[9px] text-muted-foreground">Q:{(m.qualityComponent * 100).toFixed(0)}</span>
                        <span className="text-[9px] text-muted-foreground">T:{(m.throughputComponent * 100).toFixed(0)}</span>
                        <span className="text-[9px] text-muted-foreground">C:{(m.costComponent * 100).toFixed(0)}</span>
                      </div>
                    </div>
                    {!isCurrent && (
                      <button
                        onClick={() => handleModelSwitch(m.nimModelId, m.provider, "manual")}
                        disabled={switchingModel !== null}
                        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-border/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-border/70 transition-colors"
                      >
                        {switchingModel === m.nimModelId ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <ArrowRight className="w-2.5 h-2.5" />
                        )}
                        Use
                      </button>
                    )}
                    {isCurrent && (
                      <span className="shrink-0 text-[10px] text-emerald-400 font-medium">active</span>
                    )}
                  </div>
                );
              })}
            </CardContent>
          )}
          {!ranking && !loadingRanking && (
            <CardContent className="px-4 pb-4">
              <p className="text-xs text-muted-foreground">
                Click Score to rank available models for the current phase.
              </p>
            </CardContent>
          )}
        </Card>
      )}

      {/* Cost attribution chart — shown when at least one switch has been recorded */}
      {history && history.switches.length > 0 && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              Estimated Cost Split
              <span className="text-[10px] font-normal text-muted-foreground">(throughput-based estimate)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            {/* Stacked proportion bar */}
            {history.costSplit && history.costSplit.length > 0 && history.totalEstimatedCostUsd > 0 && (() => {
              const BAR_COLORS = [
                "bg-emerald-500/70", "bg-cyan-500/70", "bg-violet-500/70",
                "bg-amber-500/70", "bg-rose-500/70", "bg-blue-500/70",
              ];
              return (
                <div>
                  <div className="flex rounded-full overflow-hidden h-3 w-full gap-px">
                    {history.costSplit.map((entry, i) => {
                      const pct = (entry.estimatedCostUsd / history.totalEstimatedCostUsd) * 100;
                      return (
                        <div
                          key={`${entry.modelId}::${entry.provider}`}
                          className={`${BAR_COLORS[i % BAR_COLORS.length]} transition-all`}
                          style={{ width: `${pct}%`, minWidth: pct > 0.5 ? "2px" : "0" }}
                          title={`${shortModelName(entry.modelId)}: ${pct.toFixed(1)}%`}
                        />
                      );
                    })}
                  </div>
                  <div className="mt-2 space-y-1">
                    {history.costSplit.map((entry, i) => {
                      const pct = (entry.estimatedCostUsd / history.totalEstimatedCostUsd) * 100;
                      return (
                        <div key={`${entry.modelId}::${entry.provider}`} className="flex items-center gap-2 text-[10px]">
                          <div className={`w-2 h-2 rounded-sm shrink-0 ${BAR_COLORS[i % BAR_COLORS.length]}`} />
                          <span className="font-mono text-foreground/80 truncate flex-1">{shortModelName(entry.modelId)}</span>
                          <span className="text-muted-foreground shrink-0">{pct.toFixed(1)}%</span>
                          <span className="text-muted-foreground shrink-0 w-14 text-right">
                            ${entry.estimatedCostUsd < 0.001
                              ? entry.estimatedCostUsd.toExponential(1)
                              : entry.estimatedCostUsd.toFixed(4)}
                          </span>
                          <span className="text-muted-foreground/60 shrink-0 w-16 text-right">
                            {entry.estimatedTokens >= 1_000_000
                              ? `${(entry.estimatedTokens / 1_000_000).toFixed(1)}M tok`
                              : entry.estimatedTokens >= 1_000
                                ? `${(entry.estimatedTokens / 1_000).toFixed(0)}k tok`
                                : `${entry.estimatedTokens} tok`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 pt-2 border-t border-border/30 flex justify-between text-[10px] text-muted-foreground">
                    <span>Total (est.)</span>
                    <span className="font-mono">
                      ${history.totalEstimatedCostUsd < 0.001
                        ? history.totalEstimatedCostUsd.toExponential(2)
                        : history.totalEstimatedCostUsd.toFixed(4)}
                      {" · "}
                      {history.totalEstimatedTokens >= 1_000_000
                        ? `${(history.totalEstimatedTokens / 1_000_000).toFixed(1)}M tok`
                        : `${(history.totalEstimatedTokens / 1_000).toFixed(0)}k tok`}
                    </span>
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Switch history */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Switch History
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {(!history?.switches || history.switches.length === 0) ? (
            <p className="text-xs text-muted-foreground">No model switches recorded for this session.</p>
          ) : (
            <div className="space-y-2">
              {history.switches.map((sw) => (
                <div key={sw.id} className="flex items-start gap-2 text-xs">
                  <div className="w-1 h-1 rounded-full bg-muted-foreground/40 mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {sw.fromModelId && (
                        <>
                          <span className="font-mono text-muted-foreground">{shortModelName(sw.fromModelId)}</span>
                          <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                        </>
                      )}
                      <span className="font-mono text-foreground">{shortModelName(sw.toModelId)}</span>
                      {sw.phase && (
                        <span className="text-[10px] text-primary border border-primary/20 bg-primary/5 rounded px-1">
                          {PHASE_LABELS[sw.phase as SessionPhase] ?? sw.phase}
                        </span>
                      )}
                      <span className={`text-[10px] rounded px-1 ${
                        sw.triggeredBy === "auto"
                          ? "text-emerald-400 border border-emerald-500/20 bg-emerald-500/5"
                          : "text-muted-foreground border border-border/30"
                      }`}>
                        {sw.triggeredBy}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(sw.switchedAt), { addSuffix: true })}
                      {" · "}
                      {sw.durationMs >= 3600000
                        ? `${(sw.durationMs / 3600000).toFixed(1)}h`
                        : sw.durationMs >= 60000
                          ? `${Math.round(sw.durationMs / 60000)}m`
                          : `${Math.round(sw.durationMs / 1000)}s`}
                      {sw.fromProvider && ` · ${providerLabel(sw.fromProvider)}`}
                      {" → "}
                      {providerLabel(sw.toProvider)}
                      {sw.reason && (
                        <span className="italic ml-1 text-muted-foreground/60">{sw.reason}</span>
                      )}
                      {sw.estimatedCostUsd > 0 && (
                        <span className="ml-1 text-muted-foreground/50">
                          · ~${sw.estimatedCostUsd < 0.001
                            ? sw.estimatedCostUsd.toExponential(1)
                            : sw.estimatedCostUsd.toFixed(4)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
