/**
 * LocalModelPicker
 *
 * Model selection UI for Mizi-Local sessions.
 * Shows locally available Ollama models with Recommended / Compatible / Too large badges.
 * Provides pull actions for both Ollama registry and HuggingFace Hub models.
 */

import { useState, useEffect } from "react";
import { Download, CheckCircle, RefreshCw, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { API_BASE_URL } from "@/lib/api-url";

interface ModelRecommendation {
  modelId: string;
  displayName: string;
  source: "ollama" | "huggingface";
  paramCount: string;
  quantization: string;
  estimatedVramGb: number;
  suitability: "recommended" | "compatible" | "too_large";
  score: number;
  rationale: string;
  tags: string[];
}

interface OllamaLocalModel {
  name: string;
  size: number;
  modified_at: string;
}

interface HFModel {
  modelId: string;
  displayName: string;
  author: string;
  ggufFile: string;
  fileSizeGb: number;
  downloads: number;
  downloadUrl: string;
  tags: string[];
}

interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  error?: string;
  done?: boolean;
}

type TabId = "recommended" | "installed" | "huggingface";

const SUITABILITY_BADGE: Record<ModelRecommendation["suitability"], React.ReactNode> = {
  recommended: <Badge className="bg-green-900/40 text-green-400 border-green-700 border text-xs">Recommended</Badge>,
  compatible:  <Badge className="bg-zinc-800 text-zinc-400 border-zinc-700 border text-xs">Compatible</Badge>,
  too_large:   <Badge className="bg-red-900/40 text-red-400 border-red-700 border text-xs">Too large</Badge>,
};

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

function PullProgressBar({ progress }: { progress: PullProgress | null }) {
  if (!progress) return null;
  const pct =
    progress.total && progress.completed
      ? Math.round((progress.completed / progress.total) * 100)
      : null;
  return (
    <div className="mt-2 text-xs text-zinc-500">
      {progress.error ? (
        <span className="text-red-400">{progress.error}</span>
      ) : progress.done ? (
        <span className="text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Done</span>
      ) : (
        <div className="space-y-1">
          <div className="flex justify-between">
            <span>{progress.status}</span>
            {pct !== null && <span>{pct}%</span>}
          </div>
          {pct !== null && (
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LocalModelPicker({
  onModelSelected,
}: {
  onModelSelected?: (modelId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("recommended");
  const [recommendations, setRecommendations] = useState<ModelRecommendation[]>([]);
  const [localModels, setLocalModels] = useState<OllamaLocalModel[]>([]);
  const [hfModels, setHfModels] = useState<HFModel[]>([]);
  const [hfQuery, setHfQuery] = useState("GGUF coding");
  const [loading, setLoading] = useState(false);
  const [hfLoading, setHfLoading] = useState(false);
  const [pullProgress, setPullProgress] = useState<Record<string, PullProgress>>({});

  const fetchRecommendations = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}api/local/recommendations`);
      if (!res.ok) return;
      const data = await res.json() as { recommendations: ModelRecommendation[] };
      setRecommendations(data.recommendations);
    } finally {
      setLoading(false);
    }
  };

  const fetchLocalModels = async () => {
    const res = await fetch(`${API_BASE_URL}api/local/ollama/models`);
    if (!res.ok) return;
    const data = await res.json() as { models: OllamaLocalModel[] };
    setLocalModels(data.models);
  };

  const searchHFModels = async () => {
    setHfLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}api/local/hf-models?q=${encodeURIComponent(hfQuery)}`);
      if (!res.ok) return;
      const data = await res.json() as { models: HFModel[] };
      setHfModels(data.models);
    } finally {
      setHfLoading(false);
    }
  };

  useEffect(() => {
    fetchRecommendations();
    fetchLocalModels();
  }, []);

  const pullOllamaModel = async (modelId: string) => {
    setPullProgress((p) => ({ ...p, [modelId]: { status: "Starting…" } }));
    const res = await fetch(`${API_BASE_URL}api/local/ollama/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6)) as PullProgress;
          setPullProgress((p) => ({ ...p, [modelId]: evt }));
          if (evt.done) { await fetchLocalModels(); }
        } catch { /* skip malformed events */ }
      }
    }
  };

  const pullHFModel = async (model: HFModel) => {
    const key = model.modelId;
    setPullProgress((p) => ({ ...p, [key]: { status: "Downloading from HuggingFace…" } }));
    const res = await fetch(`${API_BASE_URL}api/local/hf-pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: model.modelId, ggufFile: model.ggufFile }),
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6)) as PullProgress;
          setPullProgress((p) => ({ ...p, [key]: evt }));
          if (evt.done) { await fetchLocalModels(); }
        } catch { /* skip malformed events */ }
      }
    }
  };

  const isInstalled = (modelId: string) =>
    localModels.some((m) => m.name === modelId || m.name.startsWith(modelId));

  const tabs: { id: TabId; label: string }[] = [
    { id: "recommended", label: "Recommended" },
    { id: "installed", label: `Installed (${localModels.length})` },
    { id: "huggingface", label: "HuggingFace" },
  ];

  return (
    <div className="w-full space-y-2">
      {/* Tab bar */}
      <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 text-xs font-medium rounded-md px-2 py-1.5 transition-colors ${
              activeTab === t.id
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Recommended */}
      {activeTab === "recommended" && (
        <div className="space-y-2">
          {loading && (
            <div className="text-zinc-500 text-sm text-center py-4">Loading recommendations…</div>
          )}
          {recommendations.filter((r) => r.suitability !== "too_large").map((rec) => (
            <Card key={rec.modelId} className="bg-zinc-900 border-zinc-800">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-zinc-200">{rec.displayName}</span>
                      {SUITABILITY_BADGE[rec.suitability]}
                      <span className="text-xs text-zinc-500">{rec.paramCount} · {rec.quantization}</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{rec.rationale}</p>
                    <PullProgressBar progress={pullProgress[rec.modelId] ?? null} />
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {isInstalled(rec.modelId) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-green-700 text-green-400"
                        onClick={() => onModelSelected?.(rec.modelId)}
                      >
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Use
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => pullOllamaModel(rec.modelId)}
                        disabled={!!pullProgress[rec.modelId] && !pullProgress[rec.modelId].done && !pullProgress[rec.modelId].error}
                      >
                        <Download className="w-3 h-3 mr-1" />
                        Pull
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Installed */}
      {activeTab === "installed" && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={fetchLocalModels}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
          {localModels.length === 0 ? (
            <div className="text-zinc-500 text-sm text-center py-4">
              No models installed. Pull one from the Recommended tab.
            </div>
          ) : (
            localModels.map((m) => (
              <Card key={m.name} className="bg-zinc-900 border-zinc-800">
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm text-zinc-200">{m.name}</div>
                    <div className="text-xs text-zinc-500">{formatBytes(m.size)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => onModelSelected?.(m.name)}
                  >
                    Select
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* HuggingFace */}
      {activeTab === "huggingface" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={hfQuery}
              onChange={(e) => setHfQuery(e.target.value)}
              placeholder="Search HuggingFace GGUF models…"
              className="bg-zinc-900 border-zinc-700 text-zinc-200 text-sm h-8"
              onKeyDown={(e) => { if (e.key === "Enter") searchHFModels(); }}
            />
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={searchHFModels} disabled={hfLoading}>
              {hfLoading ? <div className="w-3 h-3 border border-zinc-500 border-t-transparent rounded-full animate-spin" /> : "Search"}
            </Button>
          </div>
          {hfModels.length === 0 && !hfLoading && (
            <div className="text-zinc-500 text-sm text-center py-4">
              Search HuggingFace Hub for GGUF models compatible with your hardware.
            </div>
          )}
          {hfModels.map((m) => (
            <Card key={m.modelId} className="bg-zinc-900 border-zinc-800">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-zinc-200 truncate">{m.modelId}</div>
                    <div className="text-xs text-zinc-500">
                      {m.ggufFile} · {m.fileSizeGb} GB · {(m.downloads ?? 0).toLocaleString()} downloads
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(m.tags ?? []).slice(0, 3).map((t) => (
                        <span key={t} className="text-xs bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">{t}</span>
                      ))}
                    </div>
                    <PullProgressBar progress={pullProgress[m.modelId] ?? null} />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs shrink-0"
                    onClick={() => pullHFModel(m)}
                    disabled={!!pullProgress[m.modelId] && !pullProgress[m.modelId].done && !pullProgress[m.modelId].error}
                  >
                    <Package className="w-3 h-3 mr-1" />
                    Import
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
