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
import { AISymbol, TechStackEntry, RepoGraphResponse } from "./types";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

@injectable()
export class MiziRepoContextProviderContribution implements AIVariableContribution, AIVariableResolver {
  @inject(AIVariableService)
  protected readonly variableService: AIVariableService;

  private symbolGraph: AISymbol[] = [];
  private techStack: TechStackEntry[] = [];
  private lastRefresh = 0;
  private readonly refreshIntervalMs = 60_000;

  readonly variable: AIContextVariable = {
    id: "mizi_repo_context",
    name: "mizi_repo_context",
    description: "Repository symbol graph and tech stack",
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
    if (this.techStack.length > 0) {
      parts.push("## Tech Stack\n");
      for (const entry of this.techStack) {
        parts.push(`- ${entry.framework} ${entry.version ?? ""} (${entry.category})`);
      }
      parts.push("");
    }
    if (this.symbolGraph.length > 0) {
      parts.push(`## Symbol Graph (${this.symbolGraph.length} symbols)\n`);
      const sorted = [...this.symbolGraph].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      const top = sorted.slice(0, 50);
      for (const sym of top) {
        const deps = sym.relations && sym.relations.length > 0
          ? ` depends_on: ${sym.relations.map((r) => r.target).join(", ")}`
          : "";
        parts.push(`- ${sym.kind} \`${sym.name}\` in ${sym.filePath}:${sym.line}${deps}`);
      }
      if (sorted.length > 50) {
        parts.push(`\n_… and ${sorted.length - 50} more symbols_`);
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
      this.techStack = data.techStack ?? [];
      this.lastRefresh = Date.now();
    } catch {
      // Silent
    }
  }
}
