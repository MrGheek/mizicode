---
name: Workspace proxy HTML base-path rewriting
description: How bolt.diy absolute asset paths are fixed when proxied through the API server workspace route.
---

## Rule
When proxying bolt.diy through `http-proxy-middleware` at a sub-path (e.g. `/api/sessions/:id/workspace`), bolt.diy's production HTML contains absolute asset paths (`/assets/root.css`, `/favicon.svg`). The browser resolves those against the API server origin — NOT the proxy path — causing 404 white screens.

**Fix**: Use `selfHandleResponse: true` + `responseInterceptor` in `createProxyMiddleware` to intercept HTML responses and rewrite absolute paths using `req.baseUrl`.

```typescript
selfHandleResponse: true,
on: {
  proxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
    if (!String(proxyRes.headers["content-type"] ?? "").includes("text/html")) return buffer;
    const basePath = (req as Request).baseUrl.replace(/\/$/, "");
    let html = buffer.toString("utf-8");
    html = html
      .replace(/(['"])\/(assets\/)/g, `$1${basePath}/assets/`)
      .replace(/(['"])\/favicon\.(svg|ico|png)/g, `$1${basePath}/favicon.$2`);
    return html;
  }),
}
```

**Why:** bolt.diy (wrangler pages dev) always emits absolute paths in its built HTML. There is no build-time configuration to change this base path without rebuilding the workspace Docker image. Rewriting in the proxy is simpler and doesn't require image changes.

**How to apply:** Any time bolt.diy or another Vite SPA is proxied through an Express sub-path. `selfHandleResponse` only affects HTTP, not WebSocket upgrades.
