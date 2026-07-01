import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziDoctrinePromptContribution } from "./backend-contribution";

const miziDoctrinePromptModule = new ContainerModule((bind) => {
  bind(MiziDoctrinePromptContribution).toSelf().inSingletonScope();
});
export { miziDoctrinePromptModule };
export default miziDoctrinePromptModule;
