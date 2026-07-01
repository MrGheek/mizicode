import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziLocalConfigFrontendContribution implements FrontendApplicationContribution {
  @postConstruct()
  protected init(): void {
    if (MIZI_API_BASE) {
      console.info("[MIZI] Local config: API base =", MIZI_API_BASE);
    }
  }

  onStart(): void {
    // no-op — injection handled by backend middleware
  }
}
