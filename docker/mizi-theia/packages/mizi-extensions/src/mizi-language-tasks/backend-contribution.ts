import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import { TaskContribution, TaskProviderRegistry } from "@theia/task/lib/browser/task-contribution";
import { TaskConfiguration } from "@theia/task/lib/common/task-protocol";
import { LANGUAGE_TASKS } from "./language-tasks";

@injectable()
export class MiziLanguageTasksContribution implements TaskContribution {
  registerProviders(providers: TaskProviderRegistry): void {
    providers.register("mizi", {
      provideTasks: () => Promise.resolve(LANGUAGE_TASKS),
    });
  }
}
