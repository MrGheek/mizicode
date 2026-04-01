import { Router } from "express";
import { getProfileById } from "../services/profiles";
import * as vastai from "../services/vastai";
import { logger } from "../lib/logger";

const router = Router();

router.get("/offers", async (req, res) => {
  try {
    const { profileId, gpuName, numGpus, maxPrice, limit } = req.query;

    let searchParams: vastai.VastSearchParams = {
      limit: limit ? parseInt(limit as string) : 20,
    };

    if (profileId) {
      const profile = await getProfileById(parseInt(profileId as string));
      if (profile) {
        const profileSearch = (profile.searchParams as Record<string, unknown>) || {};
        searchParams = {
          ...searchParams,
          gpu_name: profileSearch.gpu_name as string,
          num_gpus: profileSearch.num_gpus as number,
          min_gpu_ram: profileSearch.min_gpu_ram as number,
          disk_space: profile.diskSizeGb,
        };
      }
    }

    if (gpuName) searchParams.gpu_name = gpuName as string;
    if (numGpus) searchParams.num_gpus = parseInt(numGpus as string);
    if (maxPrice) {
      searchParams.extra = { ...searchParams.extra, dph_total: { lte: parseFloat(maxPrice as string) } };
    }

    const offers = await vastai.searchOffers(searchParams);

    const mapped = (offers || []).map((o: Record<string, unknown>) => ({
      id: o.id,
      gpuName: o.gpu_name,
      numGpus: o.num_gpus,
      gpuRam: Math.round((o.gpu_ram as number) || 0),
      totalRam: Math.round(((o.cpu_ram as number) || 0) / 1024),
      cpuCores: o.cpu_cores_effective || o.cpu_cores || 0,
      cpuName: o.cpu_name || "",
      diskSpace: o.disk_space || 0,
      diskName: o.disk_name || "",
      inetDown: o.inet_down || 0,
      inetUp: o.inet_up || 0,
      dphTotal: o.dph_total,
      dlperf: o.dlperf || 0,
      reliability: o.reliability || 0,
      geolocation: o.geolocation || "",
      rentable: o.rentable !== false,
      rented: o.rented === true,
      verification: o.verification || "unverified",
    }));

    res.json(mapped);
  } catch (err: unknown) {
    logger.error(err, "Failed to search offers");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to search offers: ${message}` });
  }
});

export default router;
