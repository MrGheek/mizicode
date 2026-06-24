import { ContainerModule } from "@theia/core/shared/inversify";
import { TaskContribution } from "@theia/task/lib/browser/task-contribution";
import { MiziLanguageTasksContribution } from "./backend-contribution";

export const miziLanguageTasksModule = new ContainerModule((bind) => {
  bind(MiziLanguageTasksContribution).toSelf().inSingletonScope();
  bind(TaskContribution).toService(MiziLanguageTasksContribution);
});
