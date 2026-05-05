import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity, Zap, ShieldAlert, Power, PauseCircle, PlayCircle,
  CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw, Bot,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

interface AmbientConfig {
  accountId: string;
  enabled: boolean;
  killSwitch: boolean;
  featureFlag: boolean;
  tokenBudget: number;
  gpuMinuteBudget: number;
  wallClockBudgetMs: number;
  rollingWindowMs: number;
  baseIntervalMs: number;
  policyBundle: string;
  allowListedKinds: string[];
  updatedAt: number;
}

interface AmbientCycle {
  id: number;
  startedAt: number;
  endedAt: number | null;
  status: string;
  reason: string | null;
  scoutSummary: string | null;
  gardenSummary: string | null;
  workSummary: string | null;
  tokensUsed: number;
  wallClockMs: number;
  nextWakeAt: number | null;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalsDenied: number;
  gardeningDeltas: number;
}

interface AmbientStatus {
  config: AmbientConfig;
  lastCycle: AmbientCycle | null;
  budget: {
    tokensUsed: number;
    wallClockMs: number;
    gpuMinutes: number;
    tokenBudget: number;
    wallClockBudgetMs: number;
    gpuMinuteBudget: number;
    windowStart: number;
  };
  lockHolder: string | null;
  runnerHolder: string;
  metrics: {
    cyclesRun: number;
    approvalsRequested: number;
    approvalsGranted: number;
    approvalsDenied: number;
    gardeningDeltas: number;
    proactiveWorkProposed: number;
  };
}

interface SafetyAction {
  id: number;
  kind: string;
  summary: string;
  details: Record<string, unknown> | null;
  classification: string;
  status: string;
  scope: string;
  reversible: boolean;
  externalSurface: boolean;
  policyBundle: string | null;
  createdAt: number;
  cycleId: number | null;
}

// ─── Operator token (browser-side) ────────────────────────────────────────
// Mutating ambient/safety endpoints sit behind the token-gated
// /api/ambient/* and /api/safety/* surface. The dashboard reads the
// operator's bearer token from localStorage on the operator's own
// machine — it is NEVER bundled into the build. The Settings card on
// this page exposes a small input so the operator can paste the token
// once. This matches reviewer guidance that the secret must not ship in
// the bundle and must not be served by an open browser-proxy.
const OPERATOR_TOKEN_LS_KEY = "floatr.ambient.operatorToken";
function getOperatorToken(): string {
  try { return localStorage.getItem(OPERATOR_TOKEN_LS_KEY) ?? ""; } catch { return ""; }
}
function setOperatorToken(v: string): void {
  try {
    if (v) localStorage.setItem(OPERATOR_TOKEN_LS_KEY, v);
    else localStorage.removeItem(OPERATOR_TOKEN_LS_KEY);
  } catch { /* ignore */ }
}
function authHeaders(): Record<string, string> {
  const tok = getOperatorToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(`${BASE_URL}${url}`);
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

async function postAuthed<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE_URL}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Error("Unauthorized — paste your operator token in Settings");
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

async function putAuthed<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE_URL}${url}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error("Unauthorized — paste your operator token in Settings");
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

export default function AmbientPage() {
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery<AmbientStatus>({
    queryKey: ["ambient-status"],
    queryFn: () => get<AmbientStatus>("api/dashboard/ambient/status"),
    refetchInterval: 5000,
  });

  const { data: timeline } = useQuery<{ cycles: AmbientCycle[] }>({
    queryKey: ["ambient-timeline"],
    queryFn: () => get("api/dashboard/ambient/timeline?limit=30"),
    refetchInterval: 10000,
  });

  const { data: pending } = useQuery<{ actions: SafetyAction[] }>({
    queryKey: ["safety-pending"],
    queryFn: () => get("api/dashboard/safety/pending"),
    refetchInterval: 5000,
  });

  const updateConfig = useMutation({
    mutationFn: (patch: Partial<AmbientConfig>) =>
      putAuthed<AmbientConfig>("api/ambient/config", patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ambient-status"] });
      toast.success("Ambient settings updated");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const triggerCycle = useMutation({
    mutationFn: () => postAuthed<AmbientCycle>("api/ambient/cycle", { force: true }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["ambient-status"] });
      qc.invalidateQueries({ queryKey: ["ambient-timeline"] });
      qc.invalidateQueries({ queryKey: ["safety-pending"] });
      toast.success(`Cycle #${c.id} ${c.status}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Cycle failed"),
  });

  const decideAction = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "approve" | "deny"; note?: string }) =>
      postAuthed(`api/safety/actions/${id}/${decision}`, { decidedBy: "operator", note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["safety-pending"] });
      qc.invalidateQueries({ queryKey: ["ambient-status"] });
    },
  });

  if (isLoading || !status) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const cfg = status.config;
  const tokenPct = Math.min(100, Math.round((status.budget.tokensUsed / Math.max(1, status.budget.tokenBudget)) * 100));
  const wallPct = Math.min(100, Math.round((status.budget.wallClockMs / Math.max(1, status.budget.wallClockBudgetMs)) * 100));
  const gpuPct = Math.min(100, Math.round((status.budget.gpuMinutes / Math.max(1, status.budget.gpuMinuteBudget)) * 100));

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bot className="w-6 h-6 text-primary" /> Ambient Mode
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Always-on background agent that scouts, gardens memory, and proposes proactive work — with a safety subsystem in front of every risky action.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => triggerCycle.mutate()}
            disabled={triggerCycle.isPending}
            data-testid="button-run-cycle"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${triggerCycle.isPending ? "animate-spin" : ""}`} />
            Run cycle now
          </Button>
        </div>
      </header>

      {/* Top row: status + kill switch */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className={cfg.killSwitch ? "border-red-500/50" : ""}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground uppercase tracking-wide font-medium">
              <Power className={`w-4 h-4 ${cfg.killSwitch ? "text-red-400" : cfg.enabled ? "text-emerald-400" : "text-muted-foreground"}`} /> Runner
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="kill" className="text-sm">Kill switch</Label>
              <Switch
                id="kill"
                checked={cfg.killSwitch}
                onCheckedChange={(v) => updateConfig.mutate({ killSwitch: v })}
                data-testid="switch-kill"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled" className="text-sm">Enabled</Label>
              <Switch
                id="enabled"
                checked={cfg.enabled}
                onCheckedChange={(v) => updateConfig.mutate({ enabled: v })}
                data-testid="switch-enabled"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="ff" className="text-sm">Feature flag</Label>
              <Switch
                id="ff"
                checked={cfg.featureFlag}
                onCheckedChange={(v) => updateConfig.mutate({ featureFlag: v })}
                data-testid="switch-feature-flag"
              />
            </div>
            <div className="text-[11px] text-muted-foreground border-t border-border/50 pt-2">
              Lock: {status.lockHolder ?? "—"} · Process: <code className="text-[10px]">{status.runnerHolder}</code>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground uppercase tracking-wide font-medium">
              <Activity className="w-4 h-4" /> Budget (rolling window)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Tokens</span>
                <span className="font-mono">{status.budget.tokensUsed.toLocaleString()} / {status.budget.tokenBudget.toLocaleString()}</span>
              </div>
              <div className="h-2 rounded-full bg-secondary/40 overflow-hidden">
                <div className={`h-full ${tokenPct > 80 ? "bg-red-500" : tokenPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${tokenPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Wall clock</span>
                <span className="font-mono">{Math.round(status.budget.wallClockMs/1000)}s / {Math.round(status.budget.wallClockBudgetMs/1000)}s</span>
              </div>
              <div className="h-2 rounded-full bg-secondary/40 overflow-hidden">
                <div className={`h-full ${wallPct > 80 ? "bg-red-500" : wallPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${wallPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">GPU minutes</span>
                <span className="font-mono">{status.budget.gpuMinutes.toFixed(2)} / {status.budget.gpuMinuteBudget}</span>
              </div>
              <div className="h-2 rounded-full bg-secondary/40 overflow-hidden">
                <div className={`h-full ${gpuPct > 80 ? "bg-red-500" : gpuPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${gpuPct}%` }} />
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Window: {Math.round(cfg.rollingWindowMs/3600000)}h · Base interval: {Math.round(cfg.baseIntervalMs/60000)}m · Policy: <span className="font-mono">{cfg.policyBundle}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground uppercase tracking-wide font-medium">
              <Zap className="w-4 h-4" /> 24h Metrics
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Cycles" value={status.metrics.cyclesRun} />
            <Stat label="Proposed work" value={status.metrics.proactiveWorkProposed} />
            <Stat label="Approvals" value={`${status.metrics.approvalsGranted}/${status.metrics.approvalsRequested}`} sub={`${status.metrics.approvalsDenied} denied`} />
            <Stat label="Garden Δ" value={status.metrics.gardeningDeltas} />
          </CardContent>
        </Card>
      </div>

      {/* Pending approvals */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 uppercase tracking-wide font-medium text-muted-foreground">
            <ShieldAlert className="w-4 h-4 text-amber-400" /> Pending approvals
            {pending?.actions && pending.actions.length > 0 && (
              <span className="ml-2 text-xs font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5">
                {pending.actions.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!pending?.actions || pending.actions.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              <CheckCircle2 className="w-6 h-6 mx-auto mb-2 opacity-30" />
              No pending approvals.
            </div>
          ) : (
            <div className="space-y-2">
              {pending.actions.map((a) => (
                <div key={a.id} className="border border-border/50 rounded-md p-3 flex items-start gap-3" data-testid={`approval-${a.id}`}>
                  <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-secondary/60 rounded px-1.5 py-0.5">{a.kind}</span>
                      <span className="text-xs text-muted-foreground">scope: {a.scope}</span>
                      {!a.reversible && <span className="text-xs text-red-400">irreversible</span>}
                      {a.externalSurface && <span className="text-xs text-amber-400">external</span>}
                    </div>
                    <p className="text-sm mt-1">{a.summary}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      action #{a.id} · {formatDistanceToNow(a.createdAt * 1000, { addSuffix: true })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => decideAction.mutate({ id: a.id, decision: "approve" })}
                      data-testid={`button-approve-${a.id}`}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-red-400 hover:text-red-300"
                      onClick={() => decideAction.mutate({ id: a.id, decision: "deny" })}
                      data-testid={`button-deny-${a.id}`}
                    >
                      <XCircle className="w-3 h-3 mr-1" /> Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 uppercase tracking-wide font-medium text-muted-foreground">
            <Clock className="w-4 h-4" /> Activity timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!timeline?.cycles || timeline.cycles.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              <Activity className="w-6 h-6 mx-auto mb-2 opacity-30" />
              No cycles yet.
            </div>
          ) : (
            <div className="space-y-2">
              {timeline.cycles.map((c) => <CycleRow key={c.id} cycle={c} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Operator token (browser-only secret for mutating actions) */}
      <OperatorTokenCard />

      {/* Budget config */}
      <BudgetEditor cfg={cfg} onSave={(p) => updateConfig.mutate(p)} pending={updateConfig.isPending} />
    </div>
  );
}

function OperatorTokenCard() {
  const [val, setVal] = useState(getOperatorToken());
  const [revealed, setRevealed] = useState(false);
  const present = val.length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlert className="w-4 h-4" /> Operator Token
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Mutating actions (kill switch, force cycle, approve / deny, config &amp; policy updates)
          are sent to the token-gated <code className="font-mono">/api/ambient</code> and{" "}
          <code className="font-mono">/api/safety</code> surface. Paste your{" "}
          <code className="font-mono">OMNIQL_MEM_TOKEN</code> here once — it is stored only in
          this browser&apos;s localStorage and is never bundled into the deployed dashboard.
          Read-only views (status, timeline, pending approvals) keep working without a token.
        </p>
        <div className="flex gap-2">
          <Input
            type={revealed ? "text" : "password"}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="paste operator bearer token"
            data-testid="input-operator-token"
          />
          <Button variant="outline" size="sm" onClick={() => setRevealed((v) => !v)}>
            {revealed ? "Hide" : "Show"}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOperatorToken(val);
              toast.success(val ? "Operator token saved (this browser only)" : "Operator token cleared");
            }}
            data-testid="button-save-operator-token"
          >
            Save
          </Button>
          {present && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOperatorToken("");
                setVal("");
                toast.success("Operator token cleared");
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">
          status: {present ? <span className="text-emerald-400">configured</span> : <span className="text-amber-400">not set — mutating actions will return 401</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-secondary/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tracking-tight">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
    case "running": return "text-blue-400 bg-blue-500/10 border-blue-500/30";
    case "skipped": return "text-muted-foreground bg-secondary/40 border-border/50";
    case "preempted": return "text-amber-400 bg-amber-500/10 border-amber-500/30";
    case "failed": return "text-red-400 bg-red-500/10 border-red-500/30";
    default: return "text-muted-foreground bg-secondary/40 border-border/50";
  }
}

function CycleRow({ cycle }: { cycle: AmbientCycle }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border/40 rounded-md" data-testid={`cycle-${cycle.id}`}>
      <button
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-secondary/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`text-[10px] uppercase tracking-wide font-mono px-2 py-0.5 rounded border ${statusColor(cycle.status)}`}>
          {cycle.status}
        </span>
        <span className="text-sm font-mono text-muted-foreground">#{cycle.id}</span>
        <span className="text-xs text-muted-foreground flex-1 truncate">
          {cycle.reason || cycle.scoutSummary || "—"}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {format(new Date(cycle.startedAt * 1000), "HH:mm:ss")}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 space-y-2 text-xs border-t border-border/30">
          {cycle.scoutSummary && <DetailLine label="Scout" value={cycle.scoutSummary} />}
          {cycle.gardenSummary && <DetailLine label="Garden" value={cycle.gardenSummary} />}
          {cycle.workSummary && <DetailLine label="Work" value={cycle.workSummary} />}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground font-mono pt-1">
            <span>tokens: {cycle.tokensUsed}</span>
            <span>wall: {cycle.wallClockMs}ms</span>
            <span>approvals: {cycle.approvalsGranted}/{cycle.approvalsRequested} (denied: {cycle.approvalsDenied})</span>
            <span>garden Δ: {cycle.gardeningDeltas}</span>
            {cycle.nextWakeAt && <span>next: {format(new Date(cycle.nextWakeAt * 1000), "HH:mm:ss")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide w-16 flex-shrink-0">{label}</span>
      <span className="text-xs flex-1">{value}</span>
    </div>
  );
}

function BudgetEditor({ cfg, onSave, pending }: {
  cfg: AmbientConfig;
  onSave: (patch: Partial<AmbientConfig>) => void;
  pending: boolean;
}) {
  const [tokenBudget, setTokenBudget] = useState(String(cfg.tokenBudget));
  const [wallClockBudgetMs, setWallClockBudgetMs] = useState(String(cfg.wallClockBudgetMs));
  const [baseIntervalMs, setBaseIntervalMs] = useState(String(cfg.baseIntervalMs));
  const [policyBundle, setPolicyBundle] = useState(cfg.policyBundle);
  const [allowList, setAllowList] = useState(cfg.allowListedKinds.join(","));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm uppercase tracking-wide font-medium text-muted-foreground">
          Budgets &amp; policy
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Token budget (rolling window)</Label>
          <Input value={tokenBudget} onChange={(e) => setTokenBudget(e.target.value)} type="number" data-testid="input-token-budget" />
        </div>
        <div>
          <Label className="text-xs">Wall-clock budget (ms)</Label>
          <Input value={wallClockBudgetMs} onChange={(e) => setWallClockBudgetMs(e.target.value)} type="number" data-testid="input-wall-budget" />
        </div>
        <div>
          <Label className="text-xs">Base interval (ms)</Label>
          <Input value={baseIntervalMs} onChange={(e) => setBaseIntervalMs(e.target.value)} type="number" data-testid="input-base-interval" />
        </div>
        <div>
          <Label className="text-xs">Policy bundle</Label>
          <Input value={policyBundle} onChange={(e) => setPolicyBundle(e.target.value)} data-testid="input-policy-bundle" placeholder="local-only | team-coord | external-comm" />
        </div>
        <div className="md:col-span-2">
          <Label className="text-xs">Pre-approved action kinds (comma-separated)</Label>
          <Input value={allowList} onChange={(e) => setAllowList(e.target.value)} data-testid="input-allow-list" placeholder="e.g. memory_garden_dismiss,coord_lane_note" />
        </div>
        <div className="md:col-span-2 flex justify-end">
          <Button
            disabled={pending}
            onClick={() =>
              onSave({
                tokenBudget: parseInt(tokenBudget, 10),
                wallClockBudgetMs: parseInt(wallClockBudgetMs, 10),
                baseIntervalMs: parseInt(baseIntervalMs, 10),
                policyBundle,
                allowListedKinds: allowList.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
            data-testid="button-save-budgets"
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
