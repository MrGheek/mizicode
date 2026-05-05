import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useCreateSession } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetActiveSessionQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Zap, Play, Loader2, ChevronRight, Globe, Lock, Info, CheckCircle2, WifiOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ProviderHealth {
  key: string;
  displayName: string;
  configured: boolean;
  live: boolean;
  latencyMs: number | null;
}

interface NimHealthResponse {
  providers: ProviderHealth[];
}

interface NimModel {
  nimModelId: string;
  displayName: string;
  nimTypes: string[];
  partnerProviders: string[];
  shortDescription: string;
  usecaseTags: string[];
  contextLength: string | null;
}

interface NimCatalogResponse {
  models: NimModel[];
  configured: Record<string, boolean>;
}

const PROVIDER_LABELS: Record<string, string> = {
  nvidia:   "NVIDIA NIM",
  vultr:    "Vultr",
  together: "Together AI",
  deepinfra:"DeepInfra",
};

function NimModelCard({
  model,
  configured,
  health = {},
  onLaunch,
  isLaunching,
}: {
  model: NimModel;
  configured: Record<string, boolean>;
  health?: Record<string, ProviderHealth>;
  onLaunch: (model: NimModel) => void;
  isLaunching: boolean;
}) {
  const isFree = model.nimTypes.includes("nim_type_preview");
  const hasPartner = model.partnerProviders.length > 0;
  const configuredPartners = model.partnerProviders.filter((p) => configured[p]);
  const nvidiaConfigured = configured["nvidia"];
  const canLaunch = (isFree && nvidiaConfigured) || configuredPartners.length > 0;

  const liveProviders = [
    ...(isFree && nvidiaConfigured && health["nvidia"]?.live ? ["nvidia"] : []),
    ...configuredPartners.filter((p) => health[p]?.live),
  ];
  const isLive = liveProviders.length > 0;

  return (
    <Card
      className={`flex flex-col bg-card/50 border-border/50 transition-all ${
        isLive ? "border-emerald-500/40 shadow-[0_0_12px_rgba(52,211,153,0.08)]" : ""
      } ${canLaunch ? "hover:border-primary/50 cursor-pointer" : "opacity-60"}`}
      onClick={() => canLaunch && onLaunch(model)}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-sm leading-tight">{model.displayName}</span>
              {isLive && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                  </span>
                  Live
                </span>
              )}
              {isFree && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-emerald-600/80 hover:bg-emerald-600/80 border-0">
                  Free
                </Badge>
              )}
              {hasPartner && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/60 text-amber-400">
                  Partner
                </Badge>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{model.shortDescription}</p>
          </div>
          <div className="shrink-0 flex items-center">
            {isLive ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : canLaunch ? (
              <Zap className="w-4 h-4 text-emerald-400" />
            ) : (
              <Lock className="w-3.5 h-3.5 text-muted-foreground/50" />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3 px-4 pt-0">
        <div className="flex items-center gap-2 flex-wrap">
          {model.contextLength && (
            <span className="text-[10px] text-muted-foreground font-mono">{model.contextLength} ctx</span>
          )}
          {isFree && (
            <span className="text-[10px] text-muted-foreground">
              via {nvidiaConfigured ? (
                <span className={health["nvidia"]?.live ? "text-emerald-400" : "text-muted-foreground"}>
                  NVIDIA NIM{health["nvidia"]?.live && health["nvidia"]?.latencyMs ? ` (${health["nvidia"].latencyMs}ms)` : ""}
                </span>
              ) : (
                <span className="text-muted-foreground/50">NVIDIA NIM (key needed)</span>
              )}
            </span>
          )}
          {hasPartner && configuredPartners.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {configuredPartners.map((p) => {
                const h = health[p];
                return (
                  <span key={p} className={h?.live ? "text-emerald-400" : ""}>
                    {PROVIDER_LABELS[p] ?? p}{h?.live && h?.latencyMs ? ` (${h.latencyMs}ms)` : ""}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface NimLaunchDialogProps {
  model: NimModel;
  configured: Record<string, boolean>;
  onClose: () => void;
  onConfirm: (opts: { nimModelId: string; nimProvider: string; repoUrl: string | null; intentText: string | null }) => void;
  isLaunching: boolean;
}

function NimLaunchDialog({ model, configured, onClose, onConfirm, isLaunching }: NimLaunchDialogProps) {
  const isFree = model.nimTypes.includes("nim_type_preview");
  const configuredPartners = model.partnerProviders.filter((p) => configured[p]);

  const availableProviders: string[] = [
    ...(isFree && configured["nvidia"] ? ["nvidia"] : []),
    ...configuredPartners,
  ];

  const [selectedProvider, setSelectedProvider] = useState(availableProviders[0] ?? "nvidia");
  const [repoUrl, setRepoUrl] = useState("");
  const [intentText, setIntentText] = useState("");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400" />
            Launch: {model.displayName}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">Hosted inference — workspace ready in ~2 minutes</p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {availableProviders.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</Label>
              <div className="flex gap-1.5 flex-wrap">
                {availableProviders.map((p) => (
                  <button
                    key={p}
                    onClick={() => setSelectedProvider(p)}
                    className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors ${
                      selectedProvider === p
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                    }`}
                  >
                    {PROVIDER_LABELS[p] ?? p}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              Repo URL
              <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
            </Label>
            <Input
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              className="text-sm font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              What are you working on?
              <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
            </Label>
            <Textarea
              placeholder="e.g. Add a new feature, fix a bug..."
              value={intentText}
              onChange={(e) => setIntentText(e.target.value.slice(0, 500))}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              No GPU is rented — this session uses a hosted {PROVIDER_LABELS[selectedProvider] ?? selectedProvider} API. Container boots in ~2 minutes (vs 25–35 min for local models).
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLaunching}>Cancel</Button>
          <Button
            onClick={() => onConfirm({
              nimModelId: model.nimModelId,
              nimProvider: selectedProvider,
              repoUrl: repoUrl.trim() || null,
              intentText: intentText.trim() || null,
            })}
            disabled={isLaunching || availableProviders.length === 0}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isLaunching
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Launching…</>
              : <><Zap className="w-4 h-4" /> Launch (~2 min)</>
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const BASE_URL = import.meta.env.BASE_URL ?? "/";

type NimTab = "all" | "free" | "partner";

export function NimLaunchSection() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSession = useCreateSession();

  const [catalog, setCatalog] = useState<NimCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<NimTab>("all");
  const [selectedModel, setSelectedModel] = useState<NimModel | null>(null);
  const [launchingModelId, setLaunchingModelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});

  useEffect(() => {
    fetch(`${BASE_URL}api/nim/catalog`)
      .then((r) => r.ok ? r.json() as Promise<NimCatalogResponse> : null)
      .then((data) => { if (data) setCatalog(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const fetchHealth = () => {
      fetch(`${BASE_URL}api/nim/health`)
        .then((r) => r.ok ? r.json() as Promise<NimHealthResponse> : null)
        .then((data) => {
          if (data) {
            const map: Record<string, ProviderHealth> = {};
            for (const p of data.providers) map[p.key] = p;
            setHealth(map);
          }
        })
        .catch(() => {});
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 60_000);
    return () => clearInterval(id);
  }, []);

  const handleLaunch = (opts: { nimModelId: string; nimProvider: string; repoUrl: string | null; intentText: string | null }) => {
    setLaunchingModelId(opts.nimModelId);
    createSession.mutate({
      data: {
        nimModelId: opts.nimModelId,
        nimProvider: opts.nimProvider,
        repoUrl: opts.repoUrl ?? null,
        intentText: opts.intentText ?? null,
        taskMode: null,
        tokenMode: null,
        bundleId: null,
        teamMembers: null,
      },
    }, {
      onSuccess: (session) => {
        setSelectedModel(null);
        toast({
          title: "NIM Session Launched",
          description: `${opts.nimModelId} via ${PROVIDER_LABELS[opts.nimProvider] ?? opts.nimProvider} — ready in ~2 minutes.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setLocation(`/sessions/${session.id}`);
      },
      onError: (err: Error) => {
        toast({ title: "Launch failed", description: err.message, variant: "destructive" });
      },
      onSettled: () => setLaunchingModelId(null),
    });
  };

  if (loading) return null;
  if (!catalog || catalog.models.length === 0) return null;

  const configured = catalog.configured;
  const freeModels = catalog.models.filter((m) => m.nimTypes.includes("nim_type_preview"));
  // Partner tab includes all models with upgrade_available, including hybrids (free + partner).
  const partnerModels = catalog.models.filter((m) => m.nimTypes.includes("nim_type_upgrade_available"));
  const displayModels = activeTab === "all" ? catalog.models : activeTab === "free" ? freeModels : partnerModels;
  const shownModels = expanded ? displayModels : displayModels.slice(0, 6);

  const anyConfigured = Object.values(configured).some(Boolean);
  const liveProviderList = Object.values(health).filter((p) => p.live);
  const anyLive = liveProviderList.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" />
              Hosted Inference
              {anyLive ? (
                <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                  </span>
                  {liveProviderList.map((p) => p.displayName).join(", ")} live
                </span>
              ) : (
                <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400 px-1.5 py-0">~2 min start</Badge>
              )}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">No GPU rental — powered by NVIDIA NIM and partner clouds</p>
          </div>
        </div>
        {!anyConfigured && (
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400 px-2 py-1">
            API key required
          </Badge>
        )}
        {anyLive && Object.values(health).some((p) => p.configured && !p.live) && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <WifiOff className="w-3 h-3" />
            {Object.values(health).filter((p) => p.configured && !p.live).map((p) => p.displayName).join(", ")} offline
          </span>
        )}
      </div>

      {anyLive && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/8 px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>
              <span className="font-semibold">{liveProviderList.map((p) => p.displayName).join(" & ")} {liveProviderList.length === 1 ? "is" : "are"} live</span>
              {" "}— pick a model below and start coding in ~2 minutes.
            </span>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-border/40 pb-0">
        {(["all", "free", "partner"] as NimTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setExpanded(false); }}
            className={`px-3 pb-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "all" ? `All (${catalog.models.length})` : tab === "free" ? `Free (${freeModels.length})` : `Partner (${partnerModels.length})`}
          </button>
        ))}
      </div>

      {!anyConfigured && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>
            Set <code className="font-mono">NVIDIA_NIM_API_KEY</code> in{" "}
            <a href={`${BASE_URL}settings`} className="underline text-amber-300 hover:text-amber-200">Settings → Secrets</a>
            {" "}to enable free models, or add a partner API key (Vultr, Together AI) for partner models.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {shownModels.map((model) => (
          <NimModelCard
            key={model.nimModelId}
            model={model}
            configured={configured}
            health={health}
            onLaunch={setSelectedModel}
            isLaunching={launchingModelId === model.nimModelId}
          />
        ))}
      </div>

      {displayModels.length > 6 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
          {expanded ? "Show fewer" : `Show ${displayModels.length - 6} more`}
        </button>
      )}

      {selectedModel && (
        <NimLaunchDialog
          model={selectedModel}
          configured={configured}
          onClose={() => setSelectedModel(null)}
          onConfirm={handleLaunch}
          isLaunching={!!launchingModelId}
        />
      )}
    </div>
  );
}
