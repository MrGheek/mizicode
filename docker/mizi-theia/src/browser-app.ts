import { Container } from "@theia/core/shared/inversify";
import { FrontendApplicationConfigProvider } from "@theia/core/lib/browser/frontend-application-config-provider";
import { frontendApplicationModule } from "@theia/core/lib/browser/frontend-application-module";
import { messagingFrontendModule } from "@theia/core/lib/browser/messaging/messaging-frontend-module";
import { FrontendApplication } from "@theia/core/lib/browser";
import { miziFrontendModules } from "./extensions/index";

FrontendApplicationConfigProvider.set({
  applicationName: "MIZI Theia",
});

const container = new Container();
container.load(frontendApplicationModule);
container.load(messagingFrontendModule);
for (const mod of miziFrontendModules) {
  container.load(mod);
}

const application = container.get<FrontendApplication>(FrontendApplication);
application.start();
