export interface AISymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  callers?: string[];
  callees?: string[];
}

export interface TechStackEntry {
  framework: string;
  version?: string;
  category: string;
}

export interface RepoEdge {
  from: string;
  to: string;
}

export interface RepoGraphResponse {
  symbols: AISymbol[];
  edges: RepoEdge[];
}
