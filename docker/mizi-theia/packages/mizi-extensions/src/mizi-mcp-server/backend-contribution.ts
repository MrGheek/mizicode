import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import { ToolInvocationRegistry } from "@theia/ai-core/lib/common/tool-invocation-registry";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MIZI_TOOLS: MCPToolDef[] = [
  { name: "mizi_memory_search", description: "Search MIZI semantic memory for relevant observations", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 10 } } } },
  { name: "mizi_memory_store", description: "Store an observation in MIZI memory", inputSchema: { type: "object", properties: { content: { type: "string" }, type: { type: "string", default: "note" }, source: { type: "string", default: "theia" } } } },
  { name: "mizi_repo_graph", description: "Get the repo dependency graph and symbol index", inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string", enum: ["symbols", "deps", "tech_stack"] } } } },
  { name: "mizi_skills_list", description: "List available MIZI skill bundles", inputSchema: { type: "object", properties: {} } },
  { name: "mizi_skills_eval", description: "Run a skill evaluation", inputSchema: { type: "object", properties: { skillName: { type: "string" }, testCase: { type: "string" } } } },
  { name: "mizi_plan_status", description: "Get current plan board with lane status", inputSchema: { type: "object", properties: { laneId: { type: "string", optional: true } } } },
  { name: "mizi_plan_decompose", description: "Decompose a goal into plan lanes", inputSchema: { type: "object", properties: { goal: { type: "string" }, context: { type: "string" } } } },
  { name: "mizi_swarm_run", description: "Execute a Claw Runner swarm job", inputSchema: { type: "object", properties: { prompt: { type: "string" }, model: { type: "string", optional: true }, maxTurns: { type: "number", default: 10 } } } },
  { name: "mizi_swarm_status", description: "Check status of a running swarm job", inputSchema: { type: "object", properties: { jobId: { type: "string" } } } },
  { name: "mizi_snapshot_create", description: "Create a git snapshot before a risky operation", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
  { name: "mizi_phase_set", description: "Set the current MIZI phase", inputSchema: { type: "object", properties: { phase: { type: "string", enum: ["explore", "plan", "implement", "swarm", "synthesise", "review"] } } } },
  { name: "mizi_token_mode", description: "Set the token mode", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["lean", "core", "full", "ultra"] } } } },
];

@injectable()
export class MiziMCPServerContribution {
  @inject(ToolInvocationRegistry)
  protected readonly toolRegistry: ToolInvocationRegistry;

  @postConstruct()
  protected init(): void {
    for (const tool of MIZI_TOOLS) {
      this.toolRegistry.registerTool({
        id: tool.name,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as any,
        handler: async (argString: string) => {
          try {
            const args = JSON.parse(argString);
            const resp = await fetch(`${MIZI_API_BASE}/api/mcp/call`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tool: tool.name, args }),
            });
            if (!resp.ok) {
              return { type: "error", message: `MIZI tool ${tool.name} failed: ${await resp.text()}` };
            }
            const result = await resp.json();
            return { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
          } catch (err) {
            return { type: "error", message: `MIZI tool ${tool.name} error: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });
    }
  }
}
