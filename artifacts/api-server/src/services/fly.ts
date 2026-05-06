import { logger } from "../lib/logger";

const FLY_MACHINES_BASE = "https://api.machines.dev/v1";

// Fly.io shared-CPU-1x: 1 vCPU, 256 MB RAM — sufficient for workspace containers
// (code-server + litellm proxy + claw-runner + claw-bridge; no local GPU/vLLM).
const FLY_MACHINE_SIZE = "shared-cpu-1x";
const FLY_MACHINE_MEMORY_MB = 512;

function getConfig(): { token: string; app: string } {
  const token = process.env.FLY_API_TOKEN;
  const app = process.env.FLY_APP_NAME;
  if (!token) throw new Error("FLY_API_TOKEN is not set — required to provision NIM workspace machines");
  if (!app) throw new Error("FLY_APP_NAME is not set — required to provision NIM workspace machines");
  return { token, app };
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
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: FLY_MACHINE_MEMORY_MB,
      },
      // Expose all required workspace ports as TCP services.
      // Port 22 (SSH) uses a plain TCP handler so the SSH daemon can negotiate
      // the protocol directly. Ports 3000/5180/5181/8080/8081 use http handlers
      // so Fly's edge proxy can route HTTP traffic to the right service.
      services: [
        { ports: [{ port: 22,    handlers: ["tcp"]  }], protocol: "tcp", internal_port: 22   },
        { ports: [{ port: 3000,  handlers: ["http"] }], protocol: "tcp", internal_port: 3000  },
        { ports: [{ port: 5180,  handlers: ["http"] }], protocol: "tcp", internal_port: 5180  },
        { ports: [{ port: 5181,  handlers: ["http"] }], protocol: "tcp", internal_port: 5181  },
        { ports: [{ port: 8080,  handlers: ["http"] }], protocol: "tcp", internal_port: 8080  },
        { ports: [{ port: 8081,  handlers: ["http"] }], protocol: "tcp", internal_port: 8081  },
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
