import { injectable } from "@theia/core/shared/inversify";
import { AISymbol, RepoEdge, RepoGraphResponse } from "./types";

const REFRESH_INTERVAL_MS = 60_000;

function getApiBase(): string {
  return (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";
}

@injectable()
export class RepoGraphClient {
  private symbols: AISymbol[] = [];
  private edges: RepoEdge[] = [];
  private lastFetch = 0;

  async getSymbolAtPosition(uri: string, line: number): Promise<AISymbol | undefined> {
    await this.ensureFresh();
    const path = this.uriToRepoPath(uri);
    const exact = this.symbols.find(s => s.filePath === path && s.line === line);
    if (exact) return exact;
    const fileSymbols = this.symbols.filter(s => s.filePath === path).sort((a, b) => a.line - b.line);
    for (let i = fileSymbols.length - 1; i >= 0; i--) {
      if (fileSymbols[i].line <= line) return fileSymbols[i];
    }
    return undefined;
  }

  async getCallerCandidates(symbol: AISymbol): Promise<AISymbol[]> {
    await this.ensureFresh();
    const targetPath = symbol.filePath;
    const importerPaths = new Set<string>();
    for (const edge of this.edges) {
      if (edge.to === targetPath) {
        importerPaths.add(edge.from);
      }
    }
    if (importerPaths.size === 0) return [];
    const symbolsByFile = new Map<string, AISymbol[]>();
    for (const s of this.symbols) {
      if (importerPaths.has(s.filePath)) {
        const arr = symbolsByFile.get(s.filePath);
        if (arr) arr.push(s);
        else symbolsByFile.set(s.filePath, [s]);
      }
    }
    const result: AISymbol[] = [];
    const seen = new Set<string>();
    for (const [, syms] of symbolsByFile) {
      syms.sort((a, b) => a.line - b.line);
      for (const s of syms.slice(0, 9)) {
        const key = `${s.filePath}:${s.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(s);
        }
      }
    }
    return result;
  }

  getAllSymbols(): Promise<AISymbol[]> {
    return this.ensureFresh().then(() => this.symbols);
  }

  getEdges(): Promise<RepoEdge[]> {
    return this.ensureFresh().then(() => this.edges);
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastFetch < REFRESH_INTERVAL_MS) return;
    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/repo/graph`);
      if (!resp.ok) return;
      const data: RepoGraphResponse = await resp.json();
      this.symbols = data.symbols ?? [];
      this.edges = data.edges ?? [];
      this.lastFetch = Date.now();
    } catch {
      // silent
    }
  }

  private uriToRepoPath(uri: string): string {
    const u = uri.startsWith("file://") ? uri.slice(7) : uri;
    return u.replace(/^\//, "");
  }
}
