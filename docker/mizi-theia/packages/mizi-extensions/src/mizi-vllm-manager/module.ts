import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziVLLMManagerContribution } from "./backend-contribution";
import { MiziVLLMFrontendContribution } from "./frontend-contribution";

export const miziVLLMManagerModule = new ContainerModule((bind) => {
  bind(MiziVLLMFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziVLLMFrontendContribution);
  bind(CommandContribution).toService(MiziVLLMFrontendContribution);

  bind(MiziVLLMManagerContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziVLLMManagerContribution);
});
