# Mizi-Local Changelog

## v1.0.0 — Initial Local Distribution Release

### Overview
Mizi-Local is a standalone, self-contained edition of MIZI Code that runs on any device with zero cloud dependencies. It targets owned hardware: Raspberry Pi 5 with Hailo-16L AI HAT, Mac Mini, MacBook, high-end PC, or any home server.

### What's new

#### Build system
- `MIZI_DISTRIBUTION` esbuild define flag gates all Vast.ai, Fly.io, and vLLM code out of the local bundle via dead-code elimination
- `MIZI_DISTRIBUTION=local pnpm build:local` produces a clean local build
- `pnpm package:local` produces per-platform tarballs:
  - `mizi-local-linux-arm64.tar.gz`
  - `mizi-local-linux-x64.tar.gz`
  - `mizi-local-darwin-arm64.tar.gz`
  - `mizi-local-darwin-x64.tar.gz`
- Vite dashboard build gates cloud-specific UI behind `__IS_LOCAL_BUILD__` flag

#### Hardware detection
- `hardware-probe` module runs on API server startup in local mode
- Detects: OS, architecture, CPU model, core count, total RAM, free RAM
- GPU/NPU detection: NVIDIA via `nvidia-smi`, Apple Silicon via `sysctl`, Hailo via `hailortcli`
- Exposes `GET /api/local/hardware` with full hardware profile

#### Model recommendation engine
- Maps `HardwareProfile` to a ranked list of Ollama models with suitability scores
- Tiering: <4 GB → 1–3B quants, 4–8 GB → 3–7B, 8–16 GB → 7–14B, 16–32 GB → 14–32B, 32–64 GB → 32–70B
- Apple Silicon unified memory treated as VRAM for tier calculation
- Hailo-16L gets special handling (embeddings via NPU, generation via CPU)
- Exposes `GET /api/local/recommendations`

#### Local session provider
- `provider: "local"` session type — host machine is the workspace
- No remote provisioning (no Vast.ai/Fly.io API calls in local mode)
- Ollama auto-start: checks health, then launches `ollama serve` if not running
- Exposes session start via existing sessions API with provider override

#### Ollama inference driver
- Targets `http://localhost:11434` (configurable via `OLLAMA_BASE_URL`)
- Backend auto-selection: CUDA / Metal / CPU (via Ollama's built-in detection)
- Health-check, model-list proxy, model pull with SSE progress streaming
- Chat and embedding APIs forwarded to Ollama

#### HuggingFace Hub model sourcing
- `GET /api/local/hf-models` — searches HF Hub for GGUF models matching hardware tier
- `POST /api/local/hf-pull` — downloads GGUF and imports into Ollama via `ollama create`
- Uses `huggingface-cli` if available, falls back to `curl`
- Optional `HF_TOKEN` for gated model access

#### ACP (Agent Communication Protocol)
- `acp-local.ts` implements HuggingClaw-compatible ACP for local claw invocations
- Replaces the legacy WebSocket bridge for local sessions
- Endpoints: `POST /acp/run`, `GET /acp/status/:id`, `POST /acp/abort/:id`
- Local claw runner requires `ACP_MODE=true` on port 5185

#### Workspace templates
- 7 built-in templates: debug, review, build, explore, refactor, test, document
- Each template has a system prompt fragment that feeds into Smart Skills injection
- `GET /api/local/templates` lists available templates
- Template selection in new session flow for local sessions

#### Hailo-16L backend
- Strictly gated behind hardware detection (`hasHailo=true`)
- Embeddings (memory recall, skill scoring) route to HailoRT
- Generation stays on Ollama (CPU-side) — Hailo is not suited for autoregressive LLM generation
- Pre-compiled sentence-transformer HEF at `~/.mizi/hailo-models/sentence-transformer.hef`
- Configurable via `MIZI_HAILO_HEF_DIR` and `MIZI_HAILO_EMBEDDING_HEF`

#### SQLite mode
- `lib/db/src/index-local.ts` — Drizzle + better-sqlite3 adapter
- Database at `~/.mizi/local.db` (configurable via `MIZI_LOCAL_DB_PATH`)
- WAL mode enabled for concurrent reads
- `local-migrate.ts` runs schema creation on first boot (no `pg_advisory_lock` needed)
- Local schema: sessions, local_models, workspace_templates_used, hardware_profiles

#### Dashboard local-mode UI
- `LocalHardwareCard` component: hardware summary + backend badge on home page
- `LocalModelPicker` component: model list with Recommended / Compatible / Too large badges
- Pull actions for Ollama registry and HuggingFace Hub models
- `LocalTemplateSelector` component: workspace template selection in new session flow
- Cloud-specific UI (Vast.ai offers, Fly.io config, GPU profiles) hidden when `MIZI_DISTRIBUTION=local`

#### Lightweight fallback chat UI
- `GET /api/local/chat` serves a self-contained HTML chat interface
- No React bundle required — ~5 KB of vanilla JS
- Connects to Ollama via `POST /api/local/ollama/chat` (SSE streaming)
- Suitable for low-resource devices (Raspberry Pi, old laptops)
- Shows hardware summary (backend, cores, RAM) in header

#### Setup script
- `mizi-local-start.sh` — single-command setup on any supported platform
- Detects OS and arch (Linux x64/arm64, macOS x64/arm64)
- Installs Ollama if missing (via `brew install ollama` on macOS, official script on Linux)
- Detects available backends: CUDA, Metal, Hailo
- Installs HailoRT Python package if a Hailo device is found
- Auto-selects and pulls a recommended model based on available memory
- Writes `~/.mizi/config.env` on first run

#### Service files
- **Linux systemd**: `mizi-api.service`, `mizi-dashboard.service`, `mizi-ollama.service`
- **macOS launchd**: `com.mizi.api.plist`, `com.mizi.ollama.plist`
- Install via `bash mizi-local-start.sh --install-services`

#### Configuration
- `config.env.template` ships with zero cloud API keys required
- All cloud-specific keys (VASTAI_API_KEY, FLY_API_TOKEN, etc.) absent from template
- New local-specific keys: OLLAMA_BASE_URL, MIZI_LOCAL_DB_PATH, ACP_PORT, HF_TOKEN (optional)

### Supported platforms
- Linux x86_64 (CUDA / CPU)
- Linux arm64 (CPU, Hailo-16L via HailoRT)
- macOS arm64 / Apple Silicon (Metal via Ollama)
- macOS x86_64 (CPU)

### Out of scope (v1)
- Hailo Dataflow Compiler model compilation pipeline (assumes pre-built HEF models)
- GUI graphical installer
- Automatic OTA updates
- Multi-user / team features (single-user only)
- Windows support
- HuggingFace Spaces deployment (that is HuggingClaw's domain)

### Breaking changes
None — the local distribution is additive. Cloud edition is unchanged.
All local-specific routes are prefixed `/api/local/` to avoid collisions.
