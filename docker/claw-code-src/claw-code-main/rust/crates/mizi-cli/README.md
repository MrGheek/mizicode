# mizi-cli

Terminal-native CLI (`mizi`) for chatting with an OpenAI-compatible LLM with
tool-calling (bash, file read/write, etc.), plus a REST client for the MIZI
backend (sessions, memory, skills, plans, ambient cycles, repo context).

These are two independent services — you can use either one without the
other:

- **LLM provider** — any OpenAI-compatible chat-completions endpoint
  (`OPENAI_API_KEY`/`MIZI_LLM_API_KEY` + `--provider`). Powers `-p`, `repl`.
- **MIZI backend** — the separate REST API (`MIZI_MEM_AUTH_TOKEN` +
  `api_base_url`). Powers `sessions`, and the REPL's `/memory`, `/skills`,
  `/plan`, `/ambient`, `/repo`, `/phase`, `/server-config`.

## Install

From the workspace root:

```bash
cd docker/claw-code-src/claw-code-main/rust
cargo install --path crates/mizi-cli
```

This installs `mizi` to `~/.cargo/bin/mizi` (make sure that's on your
`$PATH`). Rebuild/reinstall after pulling changes with the same command —
`cargo install` overwrites the existing binary.

## Configure

```bash
mizi config show
mizi config set --model <model-name> --provider <llm-base-url> --api-base <mizi-backend-url>
```

This persists to `~/Library/Application Support/mizi/config.toml` (macOS) /
`~/.config/mizi/config.toml` (Linux), so you don't need to pass `--model`/
`--provider` on every invocation.

- `--provider` — the LLM's OpenAI-compatible base URL. Works whether or not
  you include the `/v1` suffix (`http://localhost:11434` and
  `http://localhost:11434/v1` are equivalent) — the client normalizes it
  before building the `/v1/chat/completions` request.
- `--api-base` — the MIZI backend's base URL. Defaults to
  `https://mizi-api.fly.dev`; set to `http://localhost:8080` (or whatever
  port your local `artifacts/api-server` uses) to talk to a local instance.

## Environment variables

| Variable | Purpose |
|---|---|
| `MIZI_LLM_API_KEY` (or `OPENAI_API_KEY`) | Auth for the LLM provider. Required for `-p`/`repl`. For local servers (Ollama, a local litellm proxy) any non-empty string usually works, since they don't validate it. |
| `MIZI_MEM_AUTH_TOKEN` | Bearer token for the MIZI backend. Required for `sessions` and the REPL's remote commands. Leave unset if your local backend is running in dev mode (auth is open when no token is configured) — see `MIZI_SPEC.md`. |

## Connecting to specific endpoints

**Real OpenAI** — no `--provider` needed, it's the default:
```bash
export OPENAI_API_KEY=sk-...
mizi -p "hello"
```

**Local Ollama:**
```bash
mizi config set --provider http://localhost:11434 --model qwen2.5-coder:14b
export MIZI_LLM_API_KEY=ollama   # any non-empty value
mizi -p "hello"
```

**A vast.ai GPU box or NIM session** (litellm proxy reached over an SSH
tunnel, e.g. `ssh -L 8081:localhost:8081 ...`):
```bash
mizi config set --provider http://localhost:8081
```

**Local MIZI backend** (`artifacts/api-server`, defaults to port 8080 per
`.env.example`):
```bash
mizi config set --api-base http://localhost:8080
```

## Usage

```bash
mizi -p "prompt"              # single-shot
mizi repl                     # interactive REPL
mizi -m <model> -p "prompt"   # override model for one call
mizi --provider <url> -p "..."  # override provider for one call

mizi sessions list
mizi sessions create --title "my session"
mizi sessions show <id>
mizi sessions stop <id>

mizi config show
mizi config set --model ... --provider ... --api-base ...
```

### REPL slash commands

| Command | Description |
|---|---|
| `/help` | Show this help |
| `/clear` | Clear conversation history |
| `/save` | Save session to disk |
| `/load <file>` | Load session from disk |
| `/memory <query>` | Recall memories from MIZI API |
| `/observe <text>` | Store an observation |
| `/skills` | List available skills |
| `/skill <id>` | Show a single skill |
| `/bundle` | Show the active skill bundle |
| `/plan [id]` | List plans, or show a single plan |
| `/ambient` | List ambient cycles |
| `/repo` | Show repo context |
| `/phase` | Show current MIZI phase |
| `/server-config` | Show remote MIZI server config |
| `/exit` | Exit REPL |

Commands that hit the MIZI backend (`/memory`, `/skills`, `/plan`, `/ambient`,
`/repo`, `/phase`, `/server-config`) print
`(set MIZI_MEM_AUTH_TOKEN to enable MIZI API access)` if the token isn't set.

## Verify a build

From `docker/claw-code-src/claw-code-main/rust`:

```bash
cargo fmt -p mizi-cli
cargo clippy -p mizi-cli --all-targets --no-deps -- -D warnings
cargo test -p mizi-cli
```
