export interface AISymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  rank?: number;
  relations?: Array<{ target: string; relation: string }>;
}

export interface TechStackEntry {
  framework: string;
  version?: string;
  category: string;
}

export interface RepoGraphResponse {
  symbols?: AISymbol[];
  techStack?: TechStackEntry[];
}
