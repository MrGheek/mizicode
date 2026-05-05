# API Server

MIZI Cloud Coding — API server (Fastify + TypeScript).

---

## Production deployment — volume mount requirements

The memory database is a SQLite file managed by `better-sqlite3`. Its location is controlled by the `MEM_DATA_DIR` environment variable.

### Why a persistent volume is required

By default (when `MEM_DATA_DIR` is unset) the database is written to `~/mizi-memory`. In a containerised or cloud deployment this path lives inside the ephemeral container filesystem and **will be wiped on every restart**, losing all memory data.

To survive restarts you must:

1. Mount a **persistent volume** at a path of your choice (e.g. `/data/memory`).
2. Set `MEM_DATA_DIR` to that path before the server starts.

### Startup validation

The server validates the data directory **before** accepting any traffic. If the directory cannot be created or written to, it logs a `FATAL` error and **exits immediately** — it will not start in a degraded state. This ensures that a missing or read-only volume mount is caught at deploy time rather than discovered after data is already lost.

Example startup log on success:

```
INFO  [mem] Memory data directory validated — database will be stored at DB_PATH
      DATA_DIR=/data/memory  DB_PATH=/data/memory/mem.db  source=MEM_DATA_DIR env var
INFO  Memory database initializing  db=/data/memory/mem.db
```

Example fatal log on failure:

```
ERROR [mem] FATAL: Memory data directory "/data/memory" exists but is not writable (source: MEM_DATA_DIR env var).
      Check volume mount permissions. The server will not start without a writable data directory.
```

### Docker example

```dockerfile
# In your docker-compose.yml or Dockerfile / run command:
services:
  api:
    image: mizi-api
    environment:
      MEM_DATA_DIR: /data/memory
    volumes:
      - mem_data:/data/memory

volumes:
  mem_data:
```

### Fly.io example

```toml
# fly.toml
[env]
  MEM_DATA_DIR = "/data/memory"

[[mounts]]
  source = "mem_data"
  destination = "/data/memory"
```

### Replit Autoscale / Cloud Run

Set the `MEM_DATA_DIR` secret/env var to a path backed by a mounted persistent disk or Cloud Storage FUSE volume. Without a persistent mount the default `~/mizi-memory` path will be lost on every cold start.

---

## Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | *(required)* | Port the server listens on |
| `MEM_DATA_DIR` | `~/mizi-memory` | Path for the SQLite memory database — **must be on a persistent volume in production** |
| `LOG_LEVEL` | `info` | Pino log level (`trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`) |
