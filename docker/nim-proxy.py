#!/usr/bin/env python3
"""
Minimal OpenAI-compatible pass-through proxy for NIM (hosted inference).

Replaces litellm[proxy] which crashes on Python 3.10 when the `prisma`
package is absent (ModuleNotFoundError in its own exception handler).

Environment variables read at startup:
  NIM_API_BASE   - upstream base URL  (default: https://integrate.api.nvidia.com/v1)
  NIM_API_KEY    - upstream API key
  NIM_MODEL_ID   - model ID for the "default" alias
  SWARM_MODEL_ID - model ID for the "swarm" alias (falls back to NIM_MODEL_ID)
  SWARM_API_BASE - upstream base for swarm (falls back to NIM_API_BASE)
  SWARM_API_KEY  - API key for swarm (falls back to NIM_API_KEY)
  VLLM_PORT      - port to listen on (default: 8081)
"""
import json
import os
import sys
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn

NIM_API_BASE   = os.environ.get("NIM_API_BASE",   "https://integrate.api.nvidia.com/v1").rstrip("/")
NIM_API_KEY    = os.environ.get("NIM_API_KEY",    "")
NIM_MODEL_ID   = os.environ.get("NIM_MODEL_ID",   "")
SWARM_API_BASE = os.environ.get("SWARM_API_BASE", NIM_API_BASE).rstrip("/")
SWARM_API_KEY  = os.environ.get("SWARM_API_KEY",  NIM_API_KEY)
SWARM_MODEL_ID = os.environ.get("SWARM_MODEL_ID", NIM_MODEL_ID)
PORT           = int(os.environ.get("VLLM_PORT",  "8081"))

MODEL_ROUTES = {
    "default": (NIM_API_BASE,   NIM_API_KEY,   NIM_MODEL_ID),
    "swarm":   (SWARM_API_BASE, SWARM_API_KEY, SWARM_MODEL_ID),
}

app = FastAPI(title="NIM Proxy", docs_url=None, redoc_url=None)


@app.get("/health/liveliness")
@app.get("/health/readiness")
async def health_liveliness():
    return {"status": "ok"}


@app.get("/health")
async def health():
    return {"status": "ok", "model": NIM_MODEL_ID}


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {"id": "default",      "object": "model"},
            {"id": "swarm",        "object": "model"},
            {"id": NIM_MODEL_ID,   "object": "model"},
        ],
    }


def _route_for_body(body: dict) -> tuple:
    """Return (api_base, api_key, model_id) based on model alias in body."""
    alias = body.get("model", "default")
    if alias in MODEL_ROUTES:
        return MODEL_ROUTES[alias]
    return (NIM_API_BASE, NIM_API_KEY, alias)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
async def proxy(path: str, request: Request):
    raw = await request.body()
    api_base = NIM_API_BASE
    api_key  = NIM_API_KEY
    body_bytes = raw

    if path in ("v1/chat/completions", "v1/completions") and raw:
        try:
            body = json.loads(raw)
            api_base, api_key, model_id = _route_for_body(body)
            body["model"] = model_id
            body_bytes = json.dumps(body).encode()
        except (json.JSONDecodeError, KeyError):
            pass

    headers = {
        "authorization": f"Bearer {api_key}",
        "content-type":  request.headers.get("content-type", "application/json"),
        "accept":        request.headers.get("accept", "application/json"),
    }

    is_streaming = False
    if body_bytes:
        try:
            is_streaming = bool(json.loads(body_bytes).get("stream", False))
        except (json.JSONDecodeError, ValueError):
            pass

    # NIM_API_BASE typically ends with "/v1" (e.g. https://integrate.api.nvidia.com/v1).
    # FastAPI's /{path:path} captures the full request path WITHOUT the leading slash,
    # so a request to /v1/chat/completions gives path="v1/chat/completions".
    # Naively joining produces ".../v1/v1/chat/completions" (double prefix) → 404.
    # Strip the leading "v1/" from path when the base already ends with "/v1".
    effective_path = path[3:] if api_base.endswith("/v1") and path.startswith("v1/") else path
    url = f"{api_base}/{effective_path}"

    if is_streaming:
        async def generate():
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    method=request.method,
                    url=url,
                    content=body_bytes,
                    headers=headers,
                ) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        return StreamingResponse(generate(), media_type="text/event-stream")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.request(
            method=request.method,
            url=url,
            content=body_bytes,
            headers=headers,
        )
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


if __name__ == "__main__":
    print(f"NIM proxy starting on port {PORT}", file=sys.stderr)
    print(f"  default → {NIM_API_BASE} ({NIM_MODEL_ID})", file=sys.stderr)
    if SWARM_MODEL_ID != NIM_MODEL_ID or SWARM_API_BASE != NIM_API_BASE:
        print(f"  swarm   → {SWARM_API_BASE} ({SWARM_MODEL_ID})", file=sys.stderr)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
