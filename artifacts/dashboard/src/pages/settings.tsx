import { useState, useEffect } from "react";
import {
  Globe, CheckCircle2, XCircle, Loader2, ExternalLink, WifiOff, Activity,
  ChevronDown, ChevronRight, Layers,
} from "lucide-react";
import { FaGithub as Github } from "react-icons/fa";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";
import { useGetSchedulerConfig, useUpdateSchedulerConfig, useListProfiles, getListProfilesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { IS_LOCAL_BUILD } from "@/lib/distribution";
import { SchedulerConfigCard } from "@/components/scheduler-config-card";
import { LaneTypesPanel } from "@/components/lane-types-panel";
import { useToast } from "@/hooks/use-toast";
import type { SchedulerConfig, UpdateSchedulerRequest } from "@workspace/api-client-react";
import { getGetSchedulerConfigQueryKey } from "@workspace/api-client-react";
import { GitHubConnectionWidget } from "@/components/github-connection-widget";

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

const PROVIDER_INFO: Record<string, { desc: string; envKey: string; pricingUrl: string; freeModels: boolean }> = {
  nvidia: {
    desc: "NVIDIA NIM hosted endpoint. Provides free access to preview-tier models including Kimi K2, Devstral, Magistral, and more.",
    envKey: "NVIDIA_NIM_API_KEY",
    pricingUrl: "https://build.nvidia.com",
    freeModels: true,
  },
  vultr: {
    desc: "Vultr Cloud Inference. Partner cloud for flagship models like Kimi K2.6, DeepSeek V4, and MiniMax M2.7.",
    envKey: "VULTR_INFERENCE_API_KEY",
    pricingUrl: "https://www.vultr.com/products/cloud-inference/",
    freeModels: false,
  },
  together: {
    desc: "Together AI. Partner cloud offering a wide range of open-weight models at competitive rates.",
    envKey: "TOGETHER_API_KEY",
    pricingUrl: "https://www.together.ai/pricing",
    freeModels: false,
  },
  deepinfra: {
    desc: "DeepInfra. Partner cloud for large MoE models including Qwen3.5 and DeepSeek variants.",
    envKey: "DEEPINFRA_API_KEY",
    pricingUrl: "https://deepinfra.com/pricing",
    freeModels: false,
  },
};

function ProviderRow({ provider }: { provider: ProviderHealth }) {
  const info = PROVIDER_INFO[provider.key];
  const [connectOpen, setConnectOpen] = useState(false);

  const statusColor = provider.configured
    ? (provider.live ? "#10b981" : "#f59e0b")
    : "var(--text-muted)";
  const statusLabel = provider.configured
    ? (provider.live ? `Live${provider.latencyMs != null ? ` · ${provider.latencyMs}ms` : ""}` : "Offline")
    : "Not configured";

  return (
    <div className="py-4" style={{ borderBottom: "1px solid var(--border-glass)" }}>
      <div className="flex items-start gap-4">
        <div className="pt-0.5 shrink-0">
          {provider.configured ? (
            provider.live
              ? <CheckCircle2 className="w-4 h-4" style={{ color: "#10b981" }} />
              : <WifiOff className="w-4 h-4" style={{ color: "#f59e0b" }} />
          ) : (
            <XCircle className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{provider.displayName}</span>
            <span
              className="text-[10px] font-medium px-2 py-0.5 rounded-full"
              style={{ color: statusColor, background: `${statusColor}15`, border: `1px solid ${statusColor}25` }}
            >
              {statusLabel}
            </span>
            {info?.freeModels && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ color: "var(--accent-cyan)", background: "rgba(0,200,255,0.1)", border: "1px solid rgba(0,200,255,0.15)" }}
              >
                Free models
              </span>
            )}
          </div>
          {info && (
            <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--text-secondary)" }}>{info.desc}</p>
          )}
        </div>
        {!provider.configured && info && (
          <button
            onClick={() => setConnectOpen((v) => !v)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
            style={{
              color: "var(--accent-cyan)",
              background: "rgba(0,200,255,0.08)",
              border: "1px solid rgba(0,200,255,0.2)",
            }}
          >
            Connect →
          </button>
        )}
      </div>

      {!provider.configured && info && connectOpen && (
        <div
          className="mt-3 ml-8 p-4 rounded-xl glass-emerge"
          style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}
        >
          <p className="text-xs font-semibold mb-3" style={{ color: "var(--text-primary)" }}>Connect in 3 steps</p>
          <ol className="space-y-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{ background: "rgba(0,200,255,0.15)", color: "var(--accent-cyan)" }}>1</span>
              <span>
                Get your API key from{" "}
                <a href={info.pricingUrl} target="_blank" rel="noopener noreferrer"
                  className="underline inline-flex items-center gap-1" style={{ color: "var(--accent-cyan)" }}>
                  {provider.displayName} <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{ background: "rgba(0,200,255,0.15)", color: "var(--accent-cyan)" }}>2</span>
              <span>
                Add it to your Replit Secrets as{" "}
                <code className="px-1.5 py-0.5 rounded text-[11px] font-mono"
                  style={{ background: "var(--bg-glass-active)", color: "var(--text-primary)" }}>
                  {info.envKey}
                </code>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{ background: "rgba(0,200,255,0.15)", color: "var(--accent-cyan)" }}>3</span>
              <span>Restart the API server — it will appear as Live above.</span>
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [isSavingScheduler, setIsSavingScheduler] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: schedulerConfig } = useGetSchedulerConfig({
    query: { queryKey: getGetSchedulerConfigQueryKey() }
  });
  const updateScheduler = useUpdateSchedulerConfig();
  const { data: profiles } = useListProfiles({ query: { enabled: !IS_LOCAL_BUILD, queryKey: getListProfilesQueryKey() } });

  const fetchHealth = () => {
    if (IS_LOCAL_BUILD) { setLoading(false); return; }
    setLoading(true);
    fetch(`${BASE_URL}api/nim/health`)
      .then((r) => r.ok ? r.json() as Promise<NimHealthResponse> : null)
      .then((data) => { if (data) setProviders(data.providers); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchHealth();
    if (IS_LOCAL_BUILD) return;
    const id = setInterval(fetchHealth, 60_000);
    return () => clearInterval(id);
  }, []);

  const handleSaveScheduler = async (updates: Partial<SchedulerConfig>) => {
    setIsSavingScheduler(true);
    return new Promise<void>((resolve, reject) => {
      updateScheduler.mutate({ data: updates as UpdateSchedulerRequest }, {
        onSuccess: () => {
          toast({ title: "Scheduler saved" });
          queryClient.invalidateQueries({ queryKey: getGetSchedulerConfigQueryKey() });
          setIsSavingScheduler(false);
          resolve();
        },
        onError: (err: Error) => {
          toast({ title: "Save failed", description: err?.message, variant: "destructive" });
          setIsSavingScheduler(false);
          reject(err);
        }
      });
    });
  };

  const configuredCount = providers.filter((p) => p.configured).length;
  const liveCount = providers.filter((p) => p.live).length;

  return (
    <div className="min-h-full" style={{ background: "var(--bg-base)" }}>
      <div className="fixed top-[-200px] right-[-100px] w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(0,200,255,0.03) 0%, transparent 70%)", filter: "blur(60px)" }} />

      <div className="relative max-w-2xl mx-auto px-8 py-10 space-y-8">
        <div className="glass-emerge">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Provider Health
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Monitor inference provider status and connectivity.
          </p>
        </div>

        {/* GitHub connection card */}
        <div className="glass-card p-6 glass-emerge" style={{ animationDelay: "30ms" }}>
          <div className="flex items-center gap-2 mb-1">
            <Github className="w-4 h-4" style={{ color: "var(--accent-violet)" }} />
            <h2 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>GitHub Connection</h2>
          </div>
          <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
            Connect your GitHub account once to automatically inject a token into every session launch — no more pasting PATs.
            The operator must first create a GitHub OAuth App with callback URL <code className="font-mono">/api/auth/github/callback</code> and set{" "}
            <code className="font-mono">GITHUB_OAUTH_CLIENT_ID</code> and <code className="font-mono">GITHUB_OAUTH_CLIENT_SECRET</code>.
          </p>
          <GitHubConnectionWidget />
        </div>

        {/* Provider health card */}
        <div className="glass-card p-6 glass-emerge" style={{ animationDelay: "50ms" }}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: "var(--accent-cyan)" }} />
              <h2 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Inference Providers</h2>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--text-muted)" }} />}
            </div>
            <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              {!loading && `${configuredCount} configured · ${liveCount} live`}
            </div>
          </div>
          <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
            Hosted inference providers let you start coding in ~2 minutes without GPU rental.
          </p>

          {loading && providers.length === 0 ? (
            <div className="py-6 flex items-center justify-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              <Loader2 className="w-4 h-4 animate-spin" /> Checking provider status…
            </div>
          ) : (
            <div>
              {providers.map((p) => (
                <ProviderRow key={p.key} provider={p} />
              ))}
            </div>
          )}
        </div>

        {/* Lane Types */}
        <div className="glass-card p-6 glass-emerge" style={{ animationDelay: "100ms" }}>
          <div className="flex items-center gap-2 mb-1">
            <Layers className="w-4 h-4 shrink-0" style={{ color: "var(--accent-cyan)" }} />
            <h2 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Lane Types</h2>
          </div>
          <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
            Built-in lane types cover common roles. Create custom types for specialized domains like ML, Infra, Data, or Security.
          </p>
          <LaneTypesPanel />
        </div>

        {/* Scheduled sessions collapsible */}
        <div className="glass-card overflow-hidden glass-emerge" style={{ animationDelay: "150ms" }}>
          <button
            type="button"
            onClick={() => setSchedulerOpen((v) => !v)}
            className="w-full flex items-center gap-3 px-6 py-4 transition-colors text-left"
            style={{ color: "var(--text-primary)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-glass)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
          >
            <Globe className="w-4 h-4 shrink-0" style={{ color: "var(--text-secondary)" }} />
            <span className="flex-1 font-semibold text-sm">Scheduled Sessions</span>
            <span className="text-xs mr-2" style={{ color: "var(--text-muted)" }}>
              {schedulerConfig?.enabled ? "Active" : "Off"}
            </span>
            {schedulerOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>

          {schedulerOpen && schedulerConfig && (
            <div className="px-6 pb-6 glass-emerge">
              <SchedulerConfigCard
                config={schedulerConfig}
                profiles={profiles ?? []}
                onSave={handleSaveScheduler}
                isSaving={isSavingScheduler}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
