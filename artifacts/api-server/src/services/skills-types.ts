export type SkillClass = "doctrine" | "workflow" | "context" | "efficiency" | "team" | "repo" | "ops" | "research";
export type TrustTier = "mizi_native" | "reviewed" | "user_approved" | "experimental";
export type InstallRisk = "virtual" | "config" | "hooked" | "binary" | "networked";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type TokenMode = "full" | "core" | "lean" | "ultra";
export type TaskMode = "build" | "review" | "debug" | "refactor" | "explore" | "team";
export type SessionType = "solo" | "team";

export interface MiziSkillManifest {
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
  memoryCandidateCount: number;
  memoryLayerAccess: 1 | 2 | 3;
  memoryStaleSuppressionStrength: "strict" | "moderate" | "off";
  memoryMetadataVerbosity: "compact" | "standard" | "full";
  memoryContradictionSurfacing: "off" | "hint" | "full";
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
    memoryCandidateCount: 20,
    memoryLayerAccess: 3,
    memoryStaleSuppressionStrength: "moderate",
    memoryMetadataVerbosity: "full",
    memoryContradictionSurfacing: "full",
  },
  core: {
    mode: "core",
    label: "Core",
    description: "Default for daily development — balanced performance",
    maxContextBudget: 65536,
    responseStyleDirective: "Be clear and concise. Explain decisions briefly.",
    activeSkillCountLimit: 5,
    memoryRetrievalDepth: 2,
    memoryCandidateCount: 10,
    memoryLayerAccess: 2,
    memoryStaleSuppressionStrength: "moderate",
    memoryMetadataVerbosity: "standard",
    memoryContradictionSurfacing: "hint",
  },
  lean: {
    mode: "lean",
    label: "Lean",
    description: "Limited tools, compact memory, shorter responses",
    maxContextBudget: 32768,
    responseStyleDirective: "Be terse. Skip preamble. Answer directly.",
    activeSkillCountLimit: 4,
    memoryRetrievalDepth: 1,
    memoryCandidateCount: 5,
    memoryLayerAccess: 1,
    memoryStaleSuppressionStrength: "strict",
    memoryMetadataVerbosity: "compact",
    memoryContradictionSurfacing: "off",
  },
  ultra: {
    mode: "ultra",
    label: "Ultra",
    description: "Hot-path tools only, progressive discovery, minimum tokens",
    maxContextBudget: 16384,
    responseStyleDirective: "Respond in the fewest tokens possible. No explanations unless asked.",
    activeSkillCountLimit: 3,
    memoryRetrievalDepth: 0,
    memoryCandidateCount: 3,
    memoryLayerAccess: 1,
    memoryStaleSuppressionStrength: "strict",
    memoryMetadataVerbosity: "compact",
    memoryContradictionSurfacing: "off",
  },
};

export interface RepoIntelligenceContext {
  primaryLangs: string[];
  frameworks: string[];
  monorepo: boolean;
  graphDensity?: number;
  complexityClass?: "low" | "medium" | "high" | "very-high";
  confidenceLevel: "none" | "fingerprint" | "partial" | "full";
  isStale: boolean;
  hotspotPaths?: string[];
}

export interface SessionContext {
  sessionType: SessionType;
  taskMode: TaskMode;
  modelProfile: string;
  repoLangs: string[];
  repoKind?: string;
  tokenMode: TokenMode;
  historyScores?: Record<string, number>;
  /**
   * Eval-based lift scores (manifest.id → lift in [-MAX_EVAL_LIFT, +MAX_EVAL_LIFT]).
   * Only set when confidence ≥ MIN_EVAL_CONFIDENCE; keys absent otherwise.
   * Internal compiler input — not user-facing.
   */
  evalLiftScores?: Record<string, number>;
  repoIntelligence?: RepoIntelligenceContext;
  /**
   * Optional natural-language description of what the user is trying to
   * accomplish. Forwarded as a soft signal that future ranking/compilation
   * passes can use to bias bundle/skill selection.
   */
  intentText?: string;
}

export interface DesignContextEntry {
  category: string;
  name: string;
  data: Record<string, string>;
  tags: string[];
}

export interface CompiledBundle {
  bundleId: number;
  slug: string;
  name: string;
  skills: MiziSkillManifest[];
  reasoning: {
    task: string;
    repo: string;
    model: string;
    tokenMode: string;
    /**
     * Present when `SessionContext.intentText` was long enough (> 10 chars) to
     * influence skill ranking via the intentFit signal. Lists the goal snippet
     * and the skills whose scores were materially boosted by it.
     */
    intent?: string;
  };
  repoConfidenceLevel?: string;
  designContext?: DesignContextEntry[];
}

export interface RepoFingerprint {
  langs: string[];
  framework: string;
  monorepo: boolean;
  tests: boolean;
}
