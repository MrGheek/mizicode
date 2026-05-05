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
