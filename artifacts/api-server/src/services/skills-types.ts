export type SkillClass = "doctrine" | "workflow" | "context" | "efficiency";
export type TrustTier = "floatr_native" | "reviewed" | "user_approved" | "experimental";
export type InstallRisk = "virtual" | "config" | "hooked" | "binary" | "networked";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type TokenMode = "full" | "core" | "lean" | "ultra";
export type TaskMode = "build" | "review" | "debug" | "refactor" | "explore" | "team";
export type SessionType = "solo" | "team";

export interface FloatrSkillManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  class: SkillClass;
  source: {
    repoUrl: string;
    commitSha?: string;
    license?: string;
    trust: TrustTier;
  };
  summary: string;
  triggers: {
    tasks: TaskMode[];
    repoKinds: string[];
    sessionModes: SessionType[];
  };
  compatibility: {
    models: string[];
    interfaces: string[];
  };
  instructions: {
    system: string[];
  };
  install: {
    type: InstallRisk;
    outputs: string[];
  };
  cost: {
    tokenOverheadEstimate: number;
  };
  rankingHints: {
    taskFitWeight: number;
    repoFitWeight: number;
    measuredLiftWeight: number;
  };
  safety: {
    shellExecution: "none" | "restricted" | "full";
    networkAccess: "none" | "restricted" | "full";
  };
}

export interface TokenModeProfile {
  mode: TokenMode;
  label: string;
  description: string;
  maxContextBudget: number;
  responseStyleDirective: string;
  activeSkillCountLimit: number;
  memoryRetrievalDepth: number;
}

export const TOKEN_MODE_PROFILES: Record<TokenMode, TokenModeProfile> = {
  full: {
    mode: "full",
    label: "Full",
    description: "All active skills, richer memory, verbose reasoning",
    maxContextBudget: 128000,
    responseStyleDirective: "Provide comprehensive, well-explained responses.",
    activeSkillCountLimit: 7,
    memoryRetrievalDepth: 3,
  },
  core: {
    mode: "core",
    label: "Core",
    description: "Default for daily development — balanced performance",
    maxContextBudget: 65536,
    responseStyleDirective: "Be clear and concise. Explain decisions briefly.",
    activeSkillCountLimit: 5,
    memoryRetrievalDepth: 2,
  },
  lean: {
    mode: "lean",
    label: "Lean",
    description: "Limited tools, compact memory, shorter responses",
    maxContextBudget: 32768,
    responseStyleDirective: "Be terse. Skip preamble. Answer directly.",
    activeSkillCountLimit: 4,
    memoryRetrievalDepth: 1,
  },
  ultra: {
    mode: "ultra",
    label: "Ultra",
    description: "Hot-path tools only, progressive discovery, minimum tokens",
    maxContextBudget: 16384,
    responseStyleDirective: "Respond in the fewest tokens possible. No explanations unless asked.",
    activeSkillCountLimit: 3,
    memoryRetrievalDepth: 0,
  },
};

export interface SessionContext {
  sessionType: SessionType;
  taskMode: TaskMode;
  modelProfile: string;
  repoLangs: string[];
  repoKind?: string;
  tokenMode: TokenMode;
  historyScores?: Record<string, number>;
}

export interface CompiledBundle {
  bundleId: number;
  slug: string;
  name: string;
  skills: FloatrSkillManifest[];
  reasoning: {
    task: string;
    repo: string;
    model: string;
    tokenMode: string;
  };
}

export interface RepoFingerprint {
  langs: string[];
  framework: string;
  monorepo: boolean;
  tests: boolean;
}
