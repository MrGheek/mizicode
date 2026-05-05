import { useState, useEffect } from "react";
import { Globe, CheckCircle2, XCircle, Loader2, ExternalLink, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

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
  return (
    <div className="flex items-start gap-4 py-4 border-b border-border/40 last:border-0">
      <div className="pt-0.5 shrink-0">
        {provider.configured ? (
          provider.live
            ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            : <WifiOff className="w-4 h-4 text-amber-400" />
        ) : (
          <XCircle className="w-4 h-4 text-muted-foreground/40" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{provider.displayName}</span>
          {provider.configured ? (
            provider.live ? (
              <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/30 px-1.5 py-0">
                Live {provider.latencyMs != null ? `· ${provider.latencyMs}ms` : ""}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400 px-1.5 py-0">
                Configured · Offline
              </Badge>
            )
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground/60 px-1.5 py-0">
              Not configured
            </Badge>
          )}
          {info?.freeModels && (
            <Badge className="text-[10px] bg-primary/10 text-primary border-primary/20 px-1.5 py-0">Free models</Badge>
          )}
        </div>
        {info && (
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{info.desc}</p>
        )}
        {!provider.configured && info && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Set <code className="font-mono text-[11px] bg-secondary/60 px-1 rounded">{info.envKey}</code> in Replit Secrets to enable.
            </span>
            <a
              href={info.pricingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Get API key <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHealth = () => {
    setLoading(true);
    fetch(`${BASE_URL}api/nim/health`)
      .then((r) => r.ok ? r.json() as Promise<NimHealthResponse> : null)
      .then((data) => { if (data) setProviders(data.providers); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, 60_000);
    return () => clearInterval(id);
  }, []);

  const configuredCount = providers.filter((p) => p.configured).length;
  const liveCount = providers.filter((p) => p.live).length;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure inference providers and platform options.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-400" />
            Inference Providers
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-1" />
            ) : (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {configuredCount} configured · {liveCount} live
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Hosted-inference providers let you start a coding session in ~2 minutes without renting a GPU. Each provider requires an API key set as a Replit Secret.
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {loading && providers.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking provider status…
            </div>
          ) : (
            <div>
              {providers.map((p) => (
                <ProviderRow key={p.key} provider={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
