import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import {
  getConfig,
  updateConfig,
  runAmbientCycleNow,
  listCycles,
  getStatus,
  getMetrics,
} from "../services/ambient";
import {
  listPendingApprovals,
  listActions,
  decideAction,
  listTranscript,
  listPolicies,
  setPolicy,
  getActionById,
  type PolicyRules,
} from "../services/safety";

// ─── Authz ──────────────────────────────────────────────────────────────────
// The ambient/safety control plane and approval rail are exposed on TWO
// route prefixes that share identical handlers but differ in their auth
// posture, mirroring the memory rail (`/api/mem/*` token-gated vs
// `/api/memory/*` browser-safe proxy used by the dashboard):
//
//   • `/api/ambient/*` and `/api/safety/*` — token-gated by
//     `OMNIQL_MEM_TOKEN` (Bearer). This is the surface external
//     operators / scripts integrate against.
//   • `/api/dashboard/ambient/*` and `/api/dashboard/safety/*` — open
//     browser-safe proxy that calls the same in-process services. The
//     dashboard artifact uses these routes so that operators can drive
//     the timeline / approvals / kill switch from the UI without
//     embedding the operator secret in the browser.
//
// The browser-safe routes are still served by the same Express app and
// inherit whatever transport-layer protection the deployment environment
// provides for the dashboard origin (Replit proxy / private network /
// origin checks). Mutating routes still record operator-attribution via
// the `decidedBy` body field; this matches the memory rail's posture.

const OPERATOR_TOKEN = process.env["OMNIQL_MEM_TOKEN"];
const IS_PROD = process.env["NODE_ENV"] === "production";

if (!OPERATOR_TOKEN) {
  if (IS_PROD) {
    throw new Error(
      "OMNIQL_MEM_TOKEN must be set in production to protect ambient/safety control-plane endpoints",
    );
  }
  logger.warn("[ambient] OMNIQL_MEM_TOKEN not set — ambient/safety token-gated endpoints are open (dev mode only)");
}

function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (!OPERATOR_TOKEN) {
    next();
    return;
  }
  const auth = (req.headers["authorization"] as string | undefined) || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== OPERATOR_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Register the ambient + safety handlers onto an Express router. Path
 * prefixes are caller-supplied so we can mount the same handlers under
 * both the token-gated surface and the dashboard read-only proxy.
 *
 * `includeMutations=false` registers only safe GET endpoints. The
 * dashboard proxy uses this so unauthenticated browser callers cannot
 * approve actions, toggle the kill switch, mutate policy/config, or
 * trigger forced cycles. All mutating control-plane endpoints stay on
 * the token-gated surface only.
 */
function registerRoutes(
  router: Router,
  ambientPrefix: string,
  safetyPrefix: string,
  options: { includeMutations: boolean },
): void {
  const { includeMutations } = options;
  // ─── Ambient ────────────────────────────────────────────────────────────
  router.get(`${ambientPrefix}/status`, (req, res) => {
    try {
      const accountId = (req.query["accountId"] as string | undefined) || undefined;
      res.json({ ...getStatus(accountId), metrics: getMetrics(accountId) });
    } catch (err) {
      logger.error(err, "Failed to get ambient status");
      res.status(500).json({ error: "Failed to get ambient status" });
    }
  });

  router.get(`${ambientPrefix}/config`, (req, res) => {
    const accountId = (req.query["accountId"] as string | undefined) || undefined;
    res.json(getConfig(accountId));
  });

  if (includeMutations) {
    router.put(`${ambientPrefix}/config`, (req, res) => {
      try {
        const accountId = (req.body?.accountId as string) || "default";
        const updated = updateConfig(accountId, req.body || {});
        res.json(updated);
      } catch (err) {
        logger.error(err, "Failed to update ambient config");
        res.status(500).json({ error: "Failed to update ambient config" });
      }
    });

    router.post(`${ambientPrefix}/kill`, (req, res) => {
      try {
        const accountId = (req.body?.accountId as string) || "default";
        const engaged = !!req.body?.engaged;
        const updated = updateConfig(accountId, { killSwitch: engaged });
        res.json(updated);
      } catch (err) {
        logger.error(err, "Failed to set kill switch");
        res.status(500).json({ error: "Failed to set kill switch" });
      }
    });

    router.post(`${ambientPrefix}/cycle`, async (req, res) => {
      try {
        const force = !!req.body?.force;
        const accountId = (req.body?.accountId as string | undefined) || undefined;
        const summary = await runAmbientCycleNow({ force, accountId });
        // Normalize: expose `id` alongside `cycleId` so the dashboard
        // (which uses AmbientCycle.id from listCycles) gets a consistent
        // shape and `Cycle #${c.id}` renders correctly.
        res.json({ id: summary.cycleId, ...summary });
      } catch (err) {
        logger.error(err, "Failed to run ambient cycle");
        res.status(500).json({ error: "Failed to run ambient cycle" });
      }
    });
  }

  router.get(`${ambientPrefix}/timeline`, (req, res) => {
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 50;
    const offset = req.query["offset"] ? parseInt(String(req.query["offset"]), 10) : 0;
    const accountId = (req.query["accountId"] as string | undefined) || undefined;
    res.json({ cycles: listCycles({ limit, offset, accountId }) });
  });

  router.get(`${ambientPrefix}/metrics`, (req, res) => {
    const windowMs = req.query["windowMs"] ? parseInt(String(req.query["windowMs"]), 10) : undefined;
    const accountId = (req.query["accountId"] as string | undefined) || undefined;
    res.json(getMetrics(accountId, windowMs));
  });

  // ─── Safety ─────────────────────────────────────────────────────────────
  router.get(`${safetyPrefix}/pending`, (req, res) => {
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 50;
    const offset = req.query["offset"] ? parseInt(String(req.query["offset"]), 10) : 0;
    const accountId = (req.query["accountId"] as string | undefined) || undefined;
    res.json({ actions: listPendingApprovals({ limit, offset, accountId }) });
  });

  router.get(`${safetyPrefix}/actions`, (req, res) => {
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 100;
    const offset = req.query["offset"] ? parseInt(String(req.query["offset"]), 10) : 0;
    const status = req.query["status"] as string | undefined;
    const accountId = (req.query["accountId"] as string | undefined) || undefined;
    res.json({
      actions: listActions({
        limit,
        offset,
        accountId,
        status: status as ReturnType<typeof listActions>[number]["status"] | undefined,
      }),
    });
  });

  router.get(`${safetyPrefix}/actions/:id`, (req, res) => {
    const id = parseInt(req.params["id"], 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid action id" });
      return;
    }
    const action = getActionById(id);
    if (!action) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const transcript = listTranscript({ actionId: id, limit: 200 });
    res.json({ action, transcript });
  });

  if (includeMutations) {
    router.post(`${safetyPrefix}/actions/:id/approve`, (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid action id" });
        return;
      }
      const decidedBy = (req.body?.decidedBy as string) || "operator";
      const note = req.body?.note as string | undefined;
      const updated = decideAction({ actionId: id, decision: "approve", decidedBy, note });
      if (!updated) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(updated);
    });

    router.post(`${safetyPrefix}/actions/:id/deny`, (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid action id" });
        return;
      }
      const decidedBy = (req.body?.decidedBy as string) || "operator";
      const note = req.body?.note as string | undefined;
      const updated = decideAction({ actionId: id, decision: "deny", decidedBy, note });
      if (!updated) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(updated);
    });
  }

  router.get(`${safetyPrefix}/transcript`, (req, res) => {
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 200;
    const offset = req.query["offset"] ? parseInt(String(req.query["offset"]), 10) : 0;
    const actionId = req.query["actionId"] ? parseInt(String(req.query["actionId"]), 10) : undefined;
    const cycleId = req.query["cycleId"] ? parseInt(String(req.query["cycleId"]), 10) : undefined;
    const kind = req.query["kind"] as string | undefined;
    res.json({ entries: listTranscript({ limit, offset, actionId, cycleId, kind }) });
  });

  router.get(`${safetyPrefix}/policies`, (_req, res) => {
    res.json({ policies: listPolicies() });
  });

  if (includeMutations) {
    router.put(`${safetyPrefix}/policies/:bundle`, (req, res) => {
      const bundle = req.params["bundle"];
      const rules = req.body?.rules as PolicyRules | undefined;
      const description = req.body?.description as string | undefined;
      if (!rules || typeof rules !== "object") {
        res.status(400).json({ error: "rules object required" });
        return;
      }
      setPolicy(bundle, rules, description);
      res.json({ ok: true });
    });
  }
}

const router = Router();

// Token-gated external surface (full read + write).
router.use("/ambient", requireOperator);
router.use("/safety", requireOperator);
registerRoutes(router, "/ambient", "/safety", { includeMutations: true });

// Browser-safe dashboard proxy: READ-ONLY. Mutating control-plane actions
// (config update, kill, cycle, approve/deny, policy update) are intentionally
// NOT registered here — operators drive those via the token-gated surface.
// The dashboard mutating buttons send the operator bearer token (entered
// once via the in-page Operator Token field, stored in localStorage on the
// operator's machine) so the secret never ships in the bundle.
registerRoutes(router, "/dashboard/ambient", "/dashboard/safety", { includeMutations: false });

export default router;
