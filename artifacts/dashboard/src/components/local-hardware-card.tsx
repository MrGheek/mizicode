/**
 * LocalHardwareCard
 *
 * Displays the host hardware capability summary on the dashboard home page
 * when MIZI_DISTRIBUTION=local. Shows CPU, RAM, backend, and GPU/NPU info.
 * Only rendered in local builds — cloud builds never import this component.
 */

import { useEffect, useState } from "react";
import { Cpu, MemoryStick, Zap, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { API_BASE_URL } from "@/lib/api-url";

interface GpuInfo {
  name: string;
  vramGb: number;
  backend: "cuda" | "metal" | "hailo" | "cpu";
}

interface HardwareProfile {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  freeRamGb: number;
  gpus: GpuInfo[];
  primaryBackend: "cuda" | "metal" | "hailo" | "cpu";
  isAppleSilicon: boolean;
  hasHailo: boolean;
  hailoTops: number | null;
  unifiedMemoryGb: number | null;
  probeTimestamp: string;
}

const BACKEND_LABELS: Record<string, { label: string; color: string }> = {
  cuda:   { label: "NVIDIA CUDA",   color: "bg-green-900/30 text-green-400 border-green-700" },
  metal:  { label: "Apple Metal",   color: "bg-blue-900/30 text-blue-400 border-blue-700" },
  hailo:  { label: "Hailo NPU",     color: "bg-purple-900/30 text-purple-400 border-purple-700" },
  cpu:    { label: "CPU",           color: "bg-zinc-800 text-zinc-400 border-zinc-700" },
};

export function LocalHardwareCard() {
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHardware = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}api/local/hardware`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as HardwareProfile;
      setHw(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load hardware info");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHardware(); }, []);

  const backendInfo = hw ? BACKEND_LABELS[hw.primaryBackend] ?? BACKEND_LABELS.cpu : null;

  const memLabel = hw?.isAppleSilicon
    ? `${hw.unifiedMemoryGb ?? hw.totalRamGb} GB unified`
    : `${hw?.totalRamGb} GB RAM`;

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-zinc-400" />
          This Device
          {backendInfo && (
            <Badge
              variant="outline"
              className={`ml-auto text-xs font-medium border ${backendInfo.color}`}
            >
              {backendInfo.label}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading && (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <div className="w-3 h-3 border border-zinc-600 border-t-transparent rounded-full animate-spin" />
            Detecting hardware…
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
            <Button variant="ghost" size="sm" onClick={fetchHardware} className="ml-auto h-6 px-2 text-xs">
              Retry
            </Button>
          </div>
        )}

        {hw && !loading && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-zinc-500">CPU</div>
              <div className="text-zinc-300 truncate" title={hw.cpuModel}>
                {hw.cpuCores}× {hw.cpuModel.split(" ").slice(0, 3).join(" ")}
              </div>

              <div className="text-zinc-500">Memory</div>
              <div className="text-zinc-300 flex items-center gap-1">
                <MemoryStick className="w-3 h-3 text-zinc-500" />
                {memLabel}
                <span className="text-zinc-600">({hw.freeRamGb} GB free)</span>
              </div>

              <div className="text-zinc-500">Platform</div>
              <div className="text-zinc-300">{hw.os} · {hw.arch}</div>

              {hw.gpus.length > 0 && hw.primaryBackend !== "metal" && (
                <>
                  <div className="text-zinc-500">GPU</div>
                  <div className="text-zinc-300 truncate">
                    {hw.gpus.map((g) => `${g.name} (${g.vramGb} GB)`).join(", ")}
                  </div>
                </>
              )}

              {hw.hasHailo && (
                <>
                  <div className="text-zinc-500">Hailo NPU</div>
                  <div className="text-zinc-300 flex items-center gap-1">
                    <Zap className="w-3 h-3 text-purple-400" />
                    {hw.hailoTops ?? 16} TOPS
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
