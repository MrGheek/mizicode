import { Router } from "express";
import { listNimModels, getConfiguredProviders, syncNimCatalog, PROVIDER_CONFIG } from "../services/nim-catalog";
import { logger } from "../lib/logger";

const router = Router();

router.get("/nim/catalog", async (req, res) => {
  try {
    const nimType = typeof req.query["nimType"] === "string" ? req.query["nimType"] : undefined;
    const models = await listNimModels(nimType);
    const configured = getConfiguredProviders();
    res.json({ models, configured });
  } catch (err) {
    logger.error({ err }, "Failed to fetch NIM catalog");
    res.status(500).json({ error: "Failed to fetch NIM catalog" });
  }
});

router.get("/nim/providers", (_req, res) => {
  const configured = getConfiguredProviders();
  const providers = Object.entries(PROVIDER_CONFIG).map(([key, info]) => ({
    key,
    displayName: info.displayName,
    configured: !!configured[key],
    apiBase: info.apiBase,
    pricingUrl: info.pricingUrl,
  }));
  res.json({ providers });
});

router.get("/nim/health", async (_req, res) => {
  const configured = getConfiguredProviders();
  const results = await Promise.all(
    Object.entries(PROVIDER_CONFIG).map(async ([key, info]) => {
      if (!configured[key]) {
        return { key, displayName: info.displayName, configured: false, live: false, latencyMs: null };
      }
      const apiKey = process.env[info.envKey];
      const start = Date.now();
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${info.apiBase}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(tid);
        const latencyMs = Date.now() - start;
        // Any non-5xx response means the provider endpoint is reachable
        const live = resp.status < 500;
        return { key, displayName: info.displayName, configured: true, live, latencyMs };
      } catch {
        return { key, displayName: info.displayName, configured: true, live: false, latencyMs: null };
      }
    })
  );
  res.json({ providers: results });
});

router.post("/nim/catalog/sync", async (req, res) => {
  const adminToken = process.env.ADMIN_SWEEP_TOKEN;
  if (!adminToken || req.headers["x-admin-token"] !== adminToken) {
    res.status(401).json({ error: "Unauthorized — x-admin-token required" });
    return;
  }
  try {
    await syncNimCatalog();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Manual NIM catalog sync failed");
    res.status(500).json({ error: "Sync failed" });
  }
});

export default router;
