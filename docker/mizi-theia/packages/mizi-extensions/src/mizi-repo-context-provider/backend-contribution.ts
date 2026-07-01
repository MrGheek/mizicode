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
import { AISymbol, RepoGraphResponse } from "./types";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

@injectable()
export class MiziRepoContextProviderContribution implements AIVariableContribution, AIVariableResolver {
  @inject(AIVariableService)
  protected readonly variableService: AIVariableService;

  private symbolGraph: AISymbol[] = [];
  private lastRefresh = 0;
  private readonly refreshIntervalMs = 60_000;

  readonly variable: AIContextVariable = {
    id: "mizi_repo_context",
    name: "mizi_repo_context",
    description: "Repository symbol graph",
    isContextVariable: true,
    label: "Repo Context",
  };

  @postConstruct()
  protected init(): void {
    this.variableService.registerVariable(this.variable);
    this.variableService.registerResolver(this.variable, this);
    this.refreshGraph().catch(() => {});
  }

  registerVariables(service: AIVariableService): void {
    service.registerVariable(this.variable);
    service.registerResolver(this.variable, this);
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return request.variable.id === this.variable.id ? 100 : 0;
  }

  async resolve(request: AIVariableResolutionRequest, _context: AIVariableContext): Promise<ResolvedAIVariable | undefined> {
    if (Date.now() - this.lastRefresh > this.refreshIntervalMs) {
      await this.refreshGraph();
    }

    const parts: string[] = [];
    if (this.symbolGraph.length > 0) {
      parts.push(`## Symbol Graph (${this.symbolGraph.length} symbols)\n`);
      for (const sym of this.symbolGraph.slice(0, 50)) {
        parts.push(`- ${sym.kind} \`${sym.name}\` in ${sym.filePath}:${sym.line}`);
      }
      if (this.symbolGraph.length > 50) {
        parts.push(`\n_… and ${this.symbolGraph.length - 50} more symbols_`);
      }
      parts.push("");
    }

    return {
      variable: this.variable,
      value: parts.join("\n"),
      contextValue: parts.join("\n"),
    } as ResolvedAIVariable;
  }

  private async refreshGraph(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/repo/graph`);
      if (!resp.ok) return;
      const data = (await resp.json()) as RepoGraphResponse;
      this.symbolGraph = data.symbols ?? [];
      this.lastRefresh = Date.now();
    } catch {
      // Silent
    }
  }
}
