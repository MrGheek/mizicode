import * as path from "path";
import * as express from "express";
import { injectable } from "@theia/core/shared/inversify";
import { BackendApplicationContribution, BackendApplicationPath } from "@theia/core/lib/node/backend-application";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

@injectable()
export class MiziLocalConfigContribution implements BackendApplicationContribution {
  configure(app: import("express").Application): void {
    // Serve frontend static files as a fallback
    const frontendDir = path.resolve(BackendApplicationPath, "lib", "frontend");
    app.use(express.static(frontendDir));

    if (!MIZI_API_BASE) return;
    app.use((_req, res, next) => {
      const originalSend = res.send.bind(res);
      (res as any).send = function (body: unknown): unknown {
        if (
          res.statusCode === 200 &&
          typeof body === "string" &&
          res.getHeader("content-type")?.toString().includes("text/html")
        ) {
          body = (body as string).replace(
            "</head>",
            `<script>window.__MIZI_API_BASE = ${JSON.stringify(MIZI_API_BASE)};</script></head>`
          );
        }
        return (originalSend as any)(body);
      };
      next();
    });
  }
}
