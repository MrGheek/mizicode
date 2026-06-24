const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

export interface OpsToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ type: string; text?: string; error?: string }>;
}

function miziCall(tool: string, args: Record<string, unknown>) {
  return fetch(`${MIZI_API_BASE}/api/mcp/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
}

export const OPS_TOOLS: OpsToolDef[] = [
  {
    name: "mizi_dns_lookup",
    description: "Perform DNS lookups (dig, nslookup) for infrastructure debugging",
    inputSchema: { type: "object", properties: { domain: { type: "string" }, type: { type: "string", enum: ["A", "AAAA", "MX", "TXT", "CNAME"], default: "A" } } },
    handler: async (args) => {
      const resp = await miziCall("dns_lookup", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_api_test",
    description: "Test API endpoints with custom method, headers, and body",
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string", default: "GET" }, headers: { type: "object" }, body: { type: "string" } } },
    handler: async (args) => {
      const resp = await miziCall("api_test", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_docker_exec",
    description: "Execute Docker commands (ps, logs, exec, compose)",
    inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "string" } } },
    handler: async (args) => {
      const resp = await miziCall("docker_exec", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_tls_check",
    description: "Check TLS certificate validity, expiry, and chain for a domain",
    inputSchema: { type: "object", properties: { host: { type: "string" }, port: { type: "number", default: 443 } } },
    handler: async (args) => {
      const resp = await miziCall("tls_check", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_db_query",
    description: "Run a read-only SQL query against the session database",
    inputSchema: { type: "object", properties: { query: { type: "string" }, database: { type: "string", default: "default" } } },
    handler: async (args) => {
      const resp = await miziCall("db_query", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_port_scan",
    description: "Scan open ports on a host to diagnose connectivity issues",
    inputSchema: { type: "object", properties: { host: { type: "string" }, ports: { type: "string", description: "Comma-separated port list, e.g. 80,443,8080" } } },
    handler: async (args) => {
      const resp = await miziCall("port_scan", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
  {
    name: "mizi_sysadmin_run",
    description: "Run a system administration command with safety checks",
    inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "string" }, description: { type: "string", description: "What this command does" } } },
    handler: async (args) => {
      const resp = await miziCall("sysadmin_run", args);
      if (!resp.ok) return { type: "error", error: await resp.text() };
      return { type: "text", text: await resp.text() };
    },
  },
];
