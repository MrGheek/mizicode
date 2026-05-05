# `docker/claw-code-src/` — bundled Claw Code source

This directory contains the upstream `instructkr/claw-code` repository
checked in as a vendor copy. The Dockerfile builds the **Rust** binary
from `claw-code-main/rust/` and ships it as the canonical `claw` CLI
inside the FLOATR coding image.

## Layout

```
docker/claw-code-src/
└── claw-code-main/        ← upstream snapshot (do not edit)
    ├── rust/              ← Rust workspace — THIS is what FLOATR ships
    │   ├── Cargo.toml
    │   └── crates/        ← rusty-claude-cli, runtime, api, commands, ...
    ├── api/               ← upstream Python port (NOT used by FLOATR)
    ├── commands/          ← upstream Python port (NOT used by FLOATR)
    ├── runtime/           ← upstream Python port (NOT used by FLOATR)
    └── tools/             ← upstream Python port (NOT used by FLOATR)
```

## What FLOATR actually uses

The Dockerfile (`docker/Dockerfile`) has two relevant references:

1. **Build stage** (`COPY claw-code-src/claw-code-main /opt/claw-code-src`,
   then `cargo build --release` inside `/opt/claw-code-src/rust`) — builds
   the `rusty-claude-cli` binary (the canonical `claw` Rust binary).

2. **Runtime stage** (`COPY claw-code-src/claw-code-main /opt/claw-code`)
   — copies the entire upstream tree into the runtime image so support
   files (templates, prompts, license, etc.) ship alongside the binary.

The Python tree under `claw-code-main/` (api/, commands/, runtime/,
tools/) is included for upstream-compatibility reasons only. It is
**not invoked at runtime** by `onstart.sh`, `claw-runner.js`, or any
service the FLOATR container runs. Do not assume it is loaded.

## If you need to upgrade Claw Code

1. Pull a new snapshot of upstream into `claw-code-main/`.
2. Rebuild the Docker image: `docker build -f docker/Dockerfile docker/`.
3. Verify the Rust workspace still compiles: the build stage runs
   `cd /opt/claw-code-src/rust && cargo build --release --bin rusty-claude-cli`.
4. Smoke-test inside the container: `claw --version` should print the
   version baked into the Rust crate, not the Python package metadata.

If upstream removes the Rust port, FLOATR will need a hard fork of the
last Rust-port commit — the Python port is not on the supported path.
