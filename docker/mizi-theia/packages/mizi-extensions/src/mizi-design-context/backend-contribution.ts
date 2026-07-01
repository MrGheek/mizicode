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

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

interface DesignCategory {
  name: string;
  entries: Array<{ title: string; summary: string; source: string }>;
}

@injectable()
export class MiziDesignContextProvider implements AIVariableContribution, AIVariableResolver {
  @inject(AIVariableService)
  protected readonly variableService: AIVariableService;

  private categories: DesignCategory[] = [];

  readonly variable: AIContextVariable = {
    id: "mizi_design_context",
    name: "mizi_design_context",
    description: "Curated design intelligence categories and entries",
    isContextVariable: true,
    label: "Design Context",
  };

  @postConstruct()
  protected init(): void {
    this.variableService.registerVariable(this.variable);
    this.variableService.registerResolver(this.variable, this);
    this.refresh().catch(() => {});
  }

  registerVariables(service: AIVariableService): void {
    service.registerVariable(this.variable);
    service.registerResolver(this.variable, this);
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return request.variable.id === this.variable.id ? 100 : 0;
  }

  async resolve(request: AIVariableResolutionRequest, _context: AIVariableContext): Promise<ResolvedAIVariable | undefined> {
    if (this.categories.length === 0) {
      return { variable: this.variable, value: "", contextValue: "" } as ResolvedAIVariable;
    }
    const parts = ["## Design Context\n"];
    for (const cat of this.categories) {
      parts.push(`### ${cat.name}\n`);
      for (const e of cat.entries) {
        parts.push(`- **${e.title}**: ${e.summary} (${e.source})`);
      }
      parts.push("");
    }
    const text = parts.join("\n");
    return { variable: this.variable, value: text, contextValue: text } as ResolvedAIVariable;
  }

  private async refresh(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/categories`);
      if (resp.ok) {
        this.categories = (await resp.json()) as DesignCategory[];
      }
    } catch {
      // Silent
    }
  }
}
