import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import {
  AIVariableService,
  AIVariableContribution,
  AIVariableResolver,
  AIVariableResolutionRequest,
  AIVariableContext,
  ResolvedAIVariable,
  AIContextVariable,
} from "@theia/ai-core/lib/common/variable-service";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

@injectable()
export class MiziMemoryBridgeContribution implements AIVariableContribution, AIVariableResolver {
  @inject(AIVariableService)
  protected readonly variableService: AIVariableService;

  readonly variable: AIContextVariable = {
    id: "mizi_memory_context",
    name: "mizi_memory_context",
    description: "MIZI semantic memory recall for the current context",
    isContextVariable: true,
    label: "Memory Context",
  };

  @postConstruct()
  protected init(): void {
    this.variableService.registerVariable(this.variable);
    this.variableService.registerResolver(this.variable, this);
  }

  registerVariables(service: AIVariableService): void {
    service.registerVariable(this.variable);
    service.registerResolver(this.variable, this);
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return request.variable.id === this.variable.id ? 100 : 0;
  }

  async resolve(request: AIVariableResolutionRequest, _context: AIVariableContext): Promise<ResolvedAIVariable | undefined> {
    try {
      const query = request.arg || "current context";
      const resp = await fetch(`${MIZI_API_BASE}/api/mem/recall?query=${encodeURIComponent(query)}&limit=10`);
      if (!resp.ok) {
      return { variable: this.variable, value: "", contextValue: "" } as ResolvedAIVariable;
      }
      const data = (await resp.json()) as { items?: Array<{ content: string; type: string; source: string; relevance: number; timestamp: string }> };
      if (!data.items || data.items.length === 0) {
        return { variable: this.variable, value: "", contextValue: "" } as ResolvedAIVariable;
      }
      const parts = ["## Memory Recall\n"];
      for (const item of data.items) {
        parts.push(`- [${item.type}] ${item.content.substring(0, 500)} (relevance: ${(item.relevance * 100).toFixed(0)}%)`);
      }
      parts.push("");
      const text = parts.join("\n");
      return { variable: this.variable, value: text, contextValue: text } as ResolvedAIVariable;
    } catch {
      return { variable: this.variable, value: "", contextValue: "" } as ResolvedAIVariable;
    }
  }
}
