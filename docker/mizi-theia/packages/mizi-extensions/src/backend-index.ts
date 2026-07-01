import { ContainerModule } from "@theia/core/shared/inversify";
import { miziRepoContextProviderModule } from "./mizi-repo-context-provider/module";
import { miziMemoryBridgeModule } from "./mizi-memory-bridge/module";
import { miziDesignContextBackendModule } from "./mizi-design-context/backend-module";
import { miziNimProviderBackendModule } from "./mizi-nim-provider/backend-module";
import { miziLocalConfigBackendModule } from "./mizi-local-config/backend-module";
import { miziMCPServerModule } from "./mizi-mcp-server/module";
import { miziClawRunnerModule } from "./mizi-claw-runner/module";
import { miziVLLMManagerBackendModule } from "./mizi-vllm-manager/backend-module";
import { miziMetricsContributorBackendModule } from "./mizi-metrics-contributor/backend-module";
import { miziDoctrinePromptModule } from "./mizi-doctrine-prompt/module";
import { miziAgentWorkflowsModule } from "./mizi-agent-workflows/module";
import { miziLanguageTasksModule } from "./mizi-language-tasks/module";
import { miziWorkingStateModule } from "./mizi-working-state/module";
import { miziTerminalOpsModule } from "./mizi-terminal-ops/module";

export const miziBackendModules: ContainerModule[] = [
  miziLocalConfigBackendModule,
  miziRepoContextProviderModule,
  miziMemoryBridgeModule,
  miziDesignContextBackendModule,
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
