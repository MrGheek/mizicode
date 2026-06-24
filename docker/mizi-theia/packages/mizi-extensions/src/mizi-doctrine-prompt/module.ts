import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziDoctrinePromptContribution } from "./backend-contribution";

export const miziDoctrinePromptModule = new ContainerModule((bind) => {
  bind(MiziDoctrinePromptContribution).toSelf().inSingletonScope();
});
