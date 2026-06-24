import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import { AgentService } from "@theia/ai-core/lib/common/agent-service";
import { ALL_AGENTS } from "./agents";

@injectable()
export class MiziAgentWorkflowsContribution {
  @inject(AgentService)
  protected readonly agentService: AgentService;

  @postConstruct()
  protected init(): void {
    for (const agent of ALL_AGENTS) {
      this.agentService.registerAgent(agent);
    }
  }
}
