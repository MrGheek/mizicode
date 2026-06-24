import { ContainerModule } from "@theia/core/shared/inversify";
import { CommandContribution } from "@theia/core/lib/common/command";
import { ChatNodeToolbarActionContribution } from "@theia/ai-chat-ui/lib/browser/chat-node-toolbar-action-contribution";
import { MiziSkillFeedbackContribution } from "./frontend-contribution";

export const miziSkillFeedbackModule = new ContainerModule((bind) => {
  bind(MiziSkillFeedbackContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(MiziSkillFeedbackContribution);
  bind(ChatNodeToolbarActionContribution).toService(MiziSkillFeedbackContribution);
});
