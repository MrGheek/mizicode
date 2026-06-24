import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import { ToolInvocationRegistry } from "@theia/ai-core/lib/common/tool-invocation-registry";
import { OPS_TOOLS } from "./ops-tools";

@injectable()
export class MiziTerminalOpsContribution {
  @inject(ToolInvocationRegistry)
  protected readonly toolRegistry: ToolInvocationRegistry;

  @postConstruct()
  protected init(): void {
    for (const tool of OPS_TOOLS) {
      this.toolRegistry.registerTool({
        id: tool.name,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as any,
        handler: async (argString: string) => {
          try {
            const args = JSON.parse(argString);
            return await tool.handler(args);
          } catch (err) {
            return { type: "error", message: `Ops tool ${tool.name} error: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });
    }
  }
}
