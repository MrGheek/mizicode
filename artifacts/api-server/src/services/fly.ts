import { logger } from "../lib/logger";

const FLY_MACHINES_BASE = "https://api.machines.dev/v1";

// Fly.io shared-CPU-1x: 1 vCPU — sufficient for workspace containers.
// performance-1x + 4096 MB: esbuild (bolt.diy's dep bundler) peaks at 800 MB–1.2 GB
// while bundling the bolt.diy node_modules on first page load. When that runs
// alongside LiteLLM Python (~400 MB) + code-server (~200 MB) + nginx/claw (~150 MB),
// the total can reach 2.0–2.5 GB — beyond the 2048 MB shared-cpu-1x limit.
// The OOM kernel-kills the esbuild Go binary mid-bundle → Vite throws
// "Error: The service was stopped" → React SSR stream aborts → black screen.
//
// performance-1x gives dedicated CPU (3–5× faster TS compilation, so esbuild
// finishes before other services spike) and supports up to 8192 MB RAM.
// 4096 MB leaves ~1.5 GB headroom even at peak, definitively eliminating OOM.
const FLY_MACHINE_SIZE = "performance-1x";
const FLY_MACHINE_MEMORY_MB = 4096;

// Returns the Fly API token and the workspace app name.
//
// FLY_WORKSPACE_APP_NAME (preferred) — the dedicated "mizi-workspace" Fly app
//   that owns all ephemeral workspace machines. Keeping workspace machines in
//   their own app prevents them from showing up in (or interfering with) the
//   "mizi-api" API server machine pool.
//
// FLY_APP_NAME (legacy fallback) — the API server's own Fly app. Accepted for
//   backwards compatibility but logs a deprecation warning. Set
//   FLY_WORKSPACE_APP_NAME=mizi-workspace on the API server to opt out.
function getConfig(): { token: string; app: string } {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error(
    "FLY_API_TOKEN is not set — required to provision NIM workspace machines. " +
    "Set it with: fly secrets set --app mizi-api FLY_API_TOKEN=<token>"
  );

  const workspaceApp = process.env.FLY_WORKSPACE_APP_NAME;
  const apiApp = process.env.FLY_APP_NAME;

  if (workspaceApp) {
    return { token, app: workspaceApp };
  }

  if (apiApp) {
    logger.warn(
      { FLY_APP_NAME: apiApp },
      "FLY_WORKSPACE_APP_NAME is not set — falling back to FLY_APP_NAME. " +
      "Workspace machines will be created inside the API server app. " +
      "Set FLY_WORKSPACE_APP_NAME=mizi-workspace to use a dedicated app."
    );
    return { token, app: apiApp };
  }

  throw new Error(
    "Neither FLY_WORKSPACE_APP_NAME nor FLY_APP_NAME is set — " +
    "required to provision NIM workspace machines. " +
    "Set FLY_WORKSPACE_APP_NAME=mizi-workspace on the API server."
  );
}

function flyHeaders(token: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function flyFetch<T = Record<string, unknown>>(
  path: string,
  opts: RequestInit & { token: string },
): Promise<T> {
  const { token, ...fetchOpts } = opts;
  const url = `${FLY_MACHINES_BASE}${path}`;
  logger.info({ url, method: fetchOpts.method || "GET" }, "Fly Machines API call");
  const res = await fetch(url, {
    ...fetchOpts,
    headers: { ...flyHeaders(token), ...(fetchOpts.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text, url }, "Fly Machines API error");
    throw new Error(`Fly Machines API error ${res.status}: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

// Fly machine state as returned by the API
export type FlyMachineState = "created" | "started" | "stopped" | "destroyed" | "replacing" | "unknown";

export interface FlyMachineResponse {
  id: string;
  private_ip?: string;
  state?: string;
  image_ref?: { registry: string; repository: string; tag: string };
  config?: Record<string, unknown>;
}

export interface CreateMachineParams {
  image: string;
  env: Record<string, string>;
  startCmd: string;
}

export interface CreateMachineResult {
  machineId: string;
  privateIp: string | null;
}

/**
 * Provision a new Fly.io Machine for a NIM workspace session.
 *
 * The onstart script is passed as the container's init command so it runs
 * on boot — identical to the Vast.ai runtype:"ssh_proxy" onstart mechanism.
 *
 * Ports 3000, 5180, 5181, 8080, 8081 are declared as TCP services so Fly's
 * proxy can reach them. Port 22 is exposed as a plain TCP service so the
 * workspace SSH daemon is reachable from the Fly edge network.
 */
export async function createMachine(params: CreateMachineParams): Promise<CreateMachineResult> {
  const { token, app } = getConfig();

  const body: Record<string, unknown> = {
    name: `mizi-nim-${Date.now()}`,
    config: {
      image: params.image,
      init: {
        // Write the onstart script to a temp file and execute it, so we can
        // pass arbitrary multi-line bash as the startup command.
        cmd: ["/bin/bash", "-c", params.startCmd],
      },
      env: params.env,
      guest: {
        // cpu_kind must match FLY_MACHINE_SIZE:
        //   "shared-cpu-1x" → "shared"  (max 2048 MB)
        //   "performance-1x" → "performance" (up to 8192 MB)
        // Sending cpu_kind: "shared" with memory_mb > 2048 returns HTTP 400.
        cpu_kind: FLY_MACHINE_SIZE.startsWith("performance") ? "performance" : "shared",
        cpus: 1,
        memory_mb: FLY_MACHINE_MEMORY_MB,
      },
      // Expose all required workspace ports as TCP services.
      // Ports 3000/5180/5181/8080/8081 use ["tls","http"] so Fly's edge
      // terminates TLS and forwards plain HTTP to the machine — this allows
      // https:// URLs (e.g. boltDiyUrl, codeServerUrl) to work correctly.
      // NOTE: Port 22 (SSH) is intentionally omitted. Fly's hallpass SSH proxy
      // always tries to bind port 22 inside the microVM; if we also declare port 22
      // as a service, hallpass and the container's sshd both try to bind it, hallpass
      // loses, crashes in a restart loop, and the machine panics. NIM sessions don't
      // need external SSH access — users connect via bolt.diy (5180) instead.
      services: [
        { ports: [{ port: 3000,  handlers: ["tls", "http"] }], protocol: "tcp", internal_port: 3000  },
        { ports: [{ port: 5180,  handlers: ["tls", "http"] }], protocol: "tcp", internal_port: 5180  },
        { ports: [{ port: 5181,  handlers: ["tls", "http"] }], protocol: "tcp", internal_port: 5181  },
        { ports: [{ port: 8080,  handlers: ["tls", "http"] }], protocol: "tcp", internal_port: 8080  },
        { ports: [{ port: 8081,  handlers: ["tls", "http"] }], protocol: "tcp", internal_port: 8081  },
      ],
      restart: { policy: "no" },
    },
    // Skip the health-check wait — session status is tracked via the onstart
    // callback (POST /sessions/:id/status), not Fly health probes.
    skip_launch: false,
  };

  const result = await flyFetch<FlyMachineResponse>(`/apps/${app}/machines`, {
    token,
    method: "POST",
    body: JSON.stringify(body),
  });

  const machineId = result.id;
  if (!machineId) {
    throw new Error("Fly Machines API returned no machine ID");
  }

  logger.info({ machineId, privateIp: result.private_ip, app }, "Fly Machine created for NIM session");

  return {
    machineId,
    privateIp: result.private_ip ?? null,
  };
}

/**
 * Destroy a Fly Machine by ID. Treats 404 as success (machine already gone).
 */
export async function destroyMachine(machineId: string): Promise<void> {
  const { token, app } = getConfig();
  try {
    // Force-stop then delete — Fly requires the machine to be stopped first
    // unless force=true is passed, which bypasses that requirement.
    await flyFetch(`/apps/${app}/machines/${machineId}?force=true`, {
      token,
      method: "DELETE",
    });
    logger.info({ machineId, app }, "Fly Machine destroyed");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      logger.warn({ machineId, app }, "Fly Machine already gone — treating as success");
      return;
    }
    throw err;
  }
}

/**
 * Execute a one-shot command inside a running Fly Machine via the Machines exec API.
 * Used to hot-reload LiteLLM config after a model switch without restarting the machine.
 *
 * Returns { exit_code, stdout, stderr } — a non-zero exit_code is treated as an error
 * by callers but does NOT throw, so a failed hot-reload is non-fatal.
 */
export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export async function execMachine(
  machineId: string,
  command: string[],
  env?: Record<string, string>,
): Promise<ExecResult> {
  const { token, app } = getConfig();
  try {
    const body: { command: string[]; timeout: number; env?: Record<string, string> } = { command, timeout: 30 };
    if (env && Object.keys(env).length > 0) body.env = env;
    const result = await flyFetch<ExecResult>(`/apps/${app}/machines/${machineId}/exec`, {
      token,
      method: "POST",
      body: JSON.stringify(body),
    });
    logger.info({ machineId, app, exit_code: result.exit_code }, "Fly Machine exec completed");
    return result;
  } catch (err) {
    logger.warn({ err, machineId, command }, "Fly Machine exec failed");
    return { exit_code: 1, stdout: "", stderr: err instanceof Error ? err.message : "unknown error" };
  }
}

/**
 * Execute a shell command inside a running Fly Machine.
 * Returns stdout text. Throws on non-zero exit or API error.
 */
export async function execMachineCommand(machineId: string, cmd: string[]): Promise<string> {
  const result = await execMachine(machineId, cmd);
  if (result.exit_code !== 0) {
    throw new Error(`exec exit ${result.exit_code}: ${result.stdout}${result.stderr ? ` | stderr: ${result.stderr}` : ""}`);
  }
  return result.stdout;
}

/**
 * Persistently update environment variables on a running Fly Machine.
 * The Fly Machines API merges the provided env map with the machine's existing
 * env config, so only the specified keys are added/overwritten — no existing
 * vars are removed. A no-wait update is issued (leaseTtl=0) so the machine
 * is not restarted; the new env is reflected on the next machine start and is
 * also immediately visible to new processes launched via exec.
 */
export async function patchMachineEnv(
  machineId: string,
  env: Record<string, string>
): Promise<void> {
  const { token, app } = getConfig();

  const machine = await flyFetch<FlyMachineResponse>(`/apps/${app}/machines/${machineId}`, { token });
  const existingEnv = ((machine.config as { env?: Record<string, string> })?.env) ?? {};

  await flyFetch(`/apps/${app}/machines/${machineId}`, {
    token,
    method: "PATCH",
    body: JSON.stringify({
      config: {
        ...machine.config,
        env: { ...existingEnv, ...env },
      },
      skip_launch: true,
    }),
  });

  logger.info({ machineId, keys: Object.keys(env) }, "Fly Machine env vars patched");
}

/**
 * Get the current lifecycle state of a Fly Machine.
 * Returns "unknown" if the machine cannot be found or the state is unrecognised.
 */
export async function getMachineState(machineId: string): Promise<FlyMachineState> {
  const { token, app } = getConfig();
  try {
    const result = await flyFetch<FlyMachineResponse>(`/apps/${app}/machines/${machineId}`, {
      token,
    });
    const state = (result.state || "unknown") as FlyMachineState;
    logger.info({ machineId, app, state }, "Fly Machine state fetched");
    return state;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      return "destroyed";
    }
    logger.warn({ err, machineId }, "Failed to fetch Fly Machine state");
    return "unknown";
  }
}
