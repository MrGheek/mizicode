import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAgentAuth } from "./middlewares/agent-auth";
import mcpRouter from "./mcp/handler";
import { errorHandler } from "./errors";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use("/api/mcp", requireAgentAuth([]), mcpRouter);

app.get("/.well-known/mcp", (_req, res) => {
  res.json({
    schema_version: "2025-03-26",
    name: "mizi",
    version: "1.0.0",
    description: "MIZI AI coding platform — sessions, memory, skills, lanes, safety approvals, planning, repo intelligence, agent tools, design intelligence, model catalog, and ambient observability.",
    mcp_url: "/api/mcp",
    auth: {
      type: "bearer",
      hint: "Pass your MIZI API key as 'Authorization: Bearer <key>'",
    },
    privilege_tiers: {
      Read: "Safe, no side effects (list, get, search, status).",
      Write: "Creates or modifies resources.",
      Admin: "High-impact or irreversible actions — requires an API key with the `admin` scope.",
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

app.use(errorHandler);

export default app;
