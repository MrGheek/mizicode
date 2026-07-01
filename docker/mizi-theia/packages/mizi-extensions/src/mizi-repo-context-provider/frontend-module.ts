import { ContainerModule } from "@theia/core/shared/inversify";
import { CallHierarchyService } from "@theia/callhierarchy/lib/browser/callhierarchy-service";
import { RepoGraphClient } from "./repo-graph-client";
import { MiziCallHierarchyService } from "./repo-callhierarchy-service";
import { MiziTypeHierarchyRegistrar } from "./repo-typehierarchy-provider";

const miziRepoContextProviderFrontendModule = new ContainerModule((bind) => {
  bind(RepoGraphClient).toSelf().inSingletonScope();
  bind(CallHierarchyService).to(MiziCallHierarchyService).inSingletonScope();
  bind(MiziTypeHierarchyRegistrar).toSelf().inSingletonScope();
});
export { miziRepoContextProviderFrontendModule };
export default miziRepoContextProviderFrontendModule;
