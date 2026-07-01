import { Container } from "@theia/core/shared/inversify";
import { backendApplicationModule } from "@theia/core/lib/node/backend-application-module";
import { messagingBackendModule } from "@theia/core/lib/node/messaging/messaging-backend-module";
import { BackendApplication } from "@theia/core/lib/node/backend-application";
import { miziBackendModules } from "./extensions/backend-index";

const container = new Container();
container.load(backendApplicationModule);
container.load(messagingBackendModule);
for (const mod of miziBackendModules) {
  container.load(mod);
}

const application = container.get<BackendApplication>(BackendApplication);
application.start();
