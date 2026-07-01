import { ContainerModule } from "@theia/core/shared/inversify";
import { miziTokenModeModule } from "./mizi-token-mode/module";
import { miziPhaseSelectorModule } from "./mizi-phase-selector/module";
import { miziRepoContextProviderModule } from "./mizi-repo-context-provider/module";
import { miziRepoContextProviderFrontendModule } from "./mizi-repo-context-provider/frontend-module";
import { miziPlanViewModule } from "./mizi-plan-view/module";
import { miziMemoryPanelModule } from "./mizi-memory-panel/module";
import { miziMemoryBridgeModule } from "./mizi-memory-bridge/module";
import { miziAmbientPanelModule } from "./mizi-ambient-panel/module";
import { miziAiPaletteModule } from "./mizi-ai-palette/module";
import { miziDesignContextModule } from "./mizi-design-context/module";
import { miziSkillsViewModule } from "./mizi-skills-view/module";
import { miziRepoIndexStatusModule } from "./mizi-repo-index-status/module";
import { miziSnapshotRollbackModule } from "./mizi-snapshot-rollback/module";
import { miziLaneCoordinatorModule } from "./mizi-lane-coordinator/module";
import { miziSessionStatusBarModule } from "./mizi-session-status-bar/module";
import { miziNimProviderBackendModule, miziNimProviderFrontendModule } from "./mizi-nim-provider/module";
import { miziLocalConfigFrontendModule, miziLocalConfigBackendModule } from "./mizi-local-config/module";
import { miziMCPServerModule } from "./mizi-mcp-server/module";
import { miziGitLanesModule } from "./mizi-git-lanes/module";
import { miziClawRunnerModule } from "./mizi-claw-runner/module";
import { miziVLLMManagerModule } from "./mizi-vllm-manager/module";
import { miziVLLMManagerBackendModule } from "./mizi-vllm-manager/backend-module";
import { miziMetricsContributorModule } from "./mizi-metrics-contributor/module";
import { miziMetricsContributorBackendModule } from "./mizi-metrics-contributor/backend-module";
import { miziDoctrinePromptModule } from "./mizi-doctrine-prompt/module";
import { miziAgentWorkflowsModule } from "./mizi-agent-workflows/module";
import { miziLanguageTasksModule } from "./mizi-language-tasks/module";
import { miziWorkingStateModule } from "./mizi-working-state/module";
import { miziSkillFeedbackModule } from "./mizi-skill-feedback/module";
import { miziTerminalOpsModule } from "./mizi-terminal-ops/module";

export const miziFrontendModules: ContainerModule[] = [
  miziLocalConfigFrontendModule,
  miziTokenModeModule,
  miziPhaseSelectorModule,
  miziPlanViewModule,
  miziMemoryPanelModule,
  miziAmbientPanelModule,
  miziAiPaletteModule,
  miziRepoIndexStatusModule,
  miziSnapshotRollbackModule,
  miziLaneCoordinatorModule,
  miziDesignContextModule,
  miziSkillsViewModule,
  miziSessionStatusBarModule,
  miziNimProviderFrontendModule,
  miziGitLanesModule,
  miziClawRunnerModule,
  miziVLLMManagerModule,
  miziMetricsContributorModule,
  miziSkillFeedbackModule,
  miziRepoContextProviderFrontendModule,
];

export const miziBackendModules: ContainerModule[] = [
  miziLocalConfigBackendModule,
  miziRepoContextProviderModule,
  miziMemoryBridgeModule,
  miziNimProviderBackendModule,
  miziMCPServerModule,
  miziClawRunnerModule,
  miziVLLMManagerBackendModule,
  miziMetricsContributorBackendModule,
  miziDoctrinePromptModule,
  miziAgentWorkflowsModule,
  miziLanguageTasksModule,
  miziWorkingStateModule,
  miziTerminalOpsModule,
];
