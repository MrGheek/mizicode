import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class MiziRepoIndexStatusContribution implements FrontendApplicationContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;

  private state: "idle" | "indexing" | "ready" | "error" = "idle";
  private symbolCount = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.updateStatusBar();
    this.intervalHandle = setInterval(() => this.poll(), 10_000);
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/repo/status`);
      if (resp.ok) {
        const data = (await resp.json()) as { state: string; symbolCount: number };
        this.state = data.state as typeof this.state;
        this.symbolCount = data.symbolCount;
        this.updateStatusBar();
      }
    } catch {
      this.state = "error";
      this.updateStatusBar();
    }
  }

  private updateStatusBar(): void {
    const icon = this.state === "indexing" ? "$(sync~spin)" : this.state === "ready" ? "$(check)" : this.state === "error" ? "$(alert)" : "$(circle-medium)";
    const text = this.state === "ready"
      ? `${icon} ${this.symbolCount} symbols`
      : `${icon} ${this.state.charAt(0).toUpperCase() + this.state.slice(1)}`;

    const entry: StatusBarEntry = {
      text,
      tooltip: `Repo index: ${this.state}`,
      alignment: StatusBarAlignment.LEFT,
      priority: 80,
    };
    this.statusBar.setElement("mizi-repo-index-status", entry);
  }
}
