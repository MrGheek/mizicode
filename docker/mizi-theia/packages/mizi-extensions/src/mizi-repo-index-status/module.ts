import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { MiziRepoIndexStatusContribution } from "./frontend-contribution";

export const miziRepoIndexStatusModule = new ContainerModule((bind) => {
  bind(MiziRepoIndexStatusContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziRepoIndexStatusContribution);
});
