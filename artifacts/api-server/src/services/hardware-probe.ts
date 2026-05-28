/**
 * hardware-probe.ts
 *
 * Detects host hardware capabilities on startup in local mode.
 * Runs OS/arch detection, RAM, CPU cores, and GPU/NPU probing (NVIDIA, Apple Silicon, Hailo).
 * Result is cached in-process and exposed via GET /local/hardware.
 */

import { execSync } from "child_process";
import os from "os";
import { logger } from "../lib/logger.js";

export type BackendType = "cuda" | "metal" | "hailo" | "cpu";

export interface GpuInfo {
  name: string;
  vramGb: number;
  backend: BackendType;
}

export interface HardwareProfile {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  freeRamGb: number;
  gpus: GpuInfo[];
  primaryBackend: BackendType;
  isAppleSilicon: boolean;
  hasHailo: boolean;
  hailoTops: number | null;
  unifiedMemoryGb: number | null;
  probeTimestamp: string;
}

let cachedProfile: HardwareProfile | null = null;

function runCmd(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 8000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return "";
  }
}

function detectNvidiaGpus(): GpuInfo[] {
  const out = runCmd(
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits"
  );
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((s) => s.trim());
      const name = parts[0] || "NVIDIA GPU";
      const vramMb = parseFloat(parts[1] || "0");
      return {
        name,
        vramGb: Math.round((vramMb / 1024) * 10) / 10,
        backend: "cuda" as BackendType,
      };
    });
}

function detectAppleSilicon(): { isAppleSilicon: boolean; unifiedMemoryGb: number | null; cpuModel: string } {
  const platform = os.platform();
  if (platform !== "darwin") return { isAppleSilicon: false, unifiedMemoryGb: null, cpuModel: "" };

  const chip = runCmd("sysctl -n machdep.cpu.brand_string");
  const isAS = chip.toLowerCase().includes("apple m");
  if (!isAS) return { isAppleSilicon: false, unifiedMemoryGb: null, cpuModel: chip };

  const memBytes = runCmd("sysctl -n hw.memsize");
  const memGb = memBytes ? Math.round((parseInt(memBytes, 10) / (1024 ** 3)) * 10) / 10 : null;

  return { isAppleSilicon: true, unifiedMemoryGb: memGb, cpuModel: chip };
}

function detectHailo(): { hasHailo: boolean; hailoTops: number | null } {
  const hrtOut = runCmd("hailortcli fw-control identify 2>/dev/null");
  if (!hrtOut) return { hasHailo: false, hailoTops: null };

  const hasHailo = hrtOut.toLowerCase().includes("hailo");
  if (!hasHailo) return { hasHailo: false, hailoTops: null };

  const topsMatch = hrtOut.match(/(\d+)\s*tops/i);
  const hailoTops = topsMatch ? parseInt(topsMatch[1], 10) : 16;
  return { hasHailo: true, hailoTops };
}

export function probeHardware(): HardwareProfile {
  if (cachedProfile) return cachedProfile;

  logger.info("[hardware-probe] Running hardware capability detection...");

  const platform = os.platform();
  const arch = os.arch();
  const cpuCores = os.cpus().length;
  const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
  const freeRamGb = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;

  const cpuModel = os.cpus()[0]?.model || "Unknown CPU";

  const { isAppleSilicon, unifiedMemoryGb, cpuModel: asCpuModel } = detectAppleSilicon();
  const resolvedCpuModel = asCpuModel || cpuModel;

  const nvGpus = detectNvidiaGpus();

  const { hasHailo, hailoTops } = detectHailo();

  let gpus: GpuInfo[] = nvGpus;
  let primaryBackend: BackendType = "cpu";

  if (nvGpus.length > 0) {
    primaryBackend = "cuda";
  } else if (isAppleSilicon) {
    primaryBackend = "metal";
    gpus = [
      {
        name: resolvedCpuModel,
        vramGb: unifiedMemoryGb ?? totalRamGb,
        backend: "metal",
      },
    ];
  } else if (hasHailo) {
    primaryBackend = "hailo";
  }

  const osName = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;

  cachedProfile = {
    os: osName,
    arch,
    cpuModel: resolvedCpuModel,
    cpuCores,
    totalRamGb,
    freeRamGb,
    gpus,
    primaryBackend,
    isAppleSilicon,
    hasHailo,
    hailoTops,
    unifiedMemoryGb,
    probeTimestamp: new Date().toISOString(),
  };

  logger.info(
    {
      os: osName,
      arch,
      cpuCores,
      totalRamGb,
      primaryBackend,
      gpuCount: gpus.length,
      hasHailo,
    },
    "[hardware-probe] Detection complete"
  );

  return cachedProfile;
}

export function clearHardwareCache(): void {
  cachedProfile = null;
}
