import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";

interface SnapshotCommit {
  hash: string;
  timestamp: string;
  message: string;
}

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class SnapshotListWidget extends Widget {
  static readonly FACTORY_ID = "mizi-snapshot-list";
  static readonly LABEL = "MIZI Snapshots";

  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  private snapshots: SnapshotCommit[] = [];

  constructor() {
    super();
    this.id = SnapshotListWidget.FACTORY_ID;
    this.title.label = SnapshotListWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-history";
    this.node.style.overflow = "auto";
    this.node.style.padding = "8px";
    this.node.style.fontSize = "13px";
  }

  @postConstruct()
  protected init(): void {
    this.fetchSnapshots();
  }

  async refresh(): Promise<void> {
    await this.fetchSnapshots();
  }

  private async fetchSnapshots(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/snapshots`);
      if (resp.ok) {
        this.snapshots = (await resp.json()) as SnapshotCommit[];
        this.render();
      }
    } catch {
      this.node.innerText = "Failed to load snapshots.";
    }
  }

  private async rollback(hash: string, message: string): Promise<void> {
    const confirmed = await this.quickInput.pick(
      [
        { label: "Yes, rollback now", description: "This will reset working tree to this snapshot", value: true },
        { label: "Cancel", description: "Keep current state", value: false },
      ],
      { placeHolder: `Rollback to ${hash.substring(0, 7)}?` }
    );
    if (!confirmed || !(confirmed as any).value) return;

    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/snapshots/${hash}/rollback`, { method: "POST" });
      if (resp.ok) {
        this.msg.info(`Rolled back to ${hash.substring(0, 7)}: ${message}`);
        this.fetchSnapshots();
      } else {
        this.msg.error(`Rollback failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private render(): void {
    if (this.snapshots.length === 0) {
      this.node.innerHTML = "<p style='color:var(--theia-descriptionForeground)'>No snapshots found.</p>";
      return;
    }

    const itemsHtml = this.snapshots
      .map(
        (s) => `
      <div style="
        border:1px solid var(--theia-editorWidget-border);
        border-left:3px solid #569cd6;
        border-radius:3px;padding:6px 8px;margin-bottom:4px;
        font-size:0.85em;cursor:pointer;
      " data-rollback="${s.hash}" data-message="${this.esc(s.message)}">
        <div style="font-family:monospace;font-weight:500">${this.esc(s.hash.substring(0, 12))}</div>
        <div style="color:var(--theia-descriptionForeground);font-size:0.9em">${this.esc(s.message)}</div>
        <div style="color:var(--theia-descriptionForeground);font-size:0.8em">${new Date(s.timestamp).toLocaleString()}</div>
      </div>`
      )
      .join("\n");

    this.node.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 8px 0">
        <h3 style="margin:0;font-size:1em">Snapshots (${this.snapshots.length})</h3>
        <a href="#" data-refresh-snapshots style="font-size:0.85em;color:var(--theia-textLink-foreground)">Refresh</a>
      </div>
      ${itemsHtml}
    `;

    this.node.querySelectorAll("[data-rollback]").forEach((el) => {
      el.addEventListener("click", () => {
        const hash = (el as HTMLElement).dataset.rollback!;
        const message = (el as HTMLElement).dataset.message ?? "";
        this.rollback(hash, message);
      });
    });
    this.node.querySelector("[data-refresh-snapshots]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.fetchSnapshots();
    });
  }

  private esc(t: string): string {
    const d = document.createElement("div");
    d.appendChild(document.createTextNode(t));
    return d.innerHTML;
  }
}
