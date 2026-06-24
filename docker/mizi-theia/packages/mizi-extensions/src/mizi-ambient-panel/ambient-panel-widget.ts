import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";

interface AmbientCycleEntry {
  type: "suggestion" | "action" | "approval_request" | "system" | "error";
  message: string;
  details?: string;
  timestamp: string;
  approved?: boolean;
}

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class AmbientPanelWidget extends Widget {
  static readonly FACTORY_ID = "mizi-ambient-panel";
  static readonly LABEL = "MIZI Ambient Agent";

  @inject(MessageService) protected readonly msg: MessageService;

  private cycles: AmbientCycleEntry[] = [];
  private sseAbortController: AbortController | null = null;

  constructor() {
    super();
    this.id = AmbientPanelWidget.FACTORY_ID;
    this.title.label = AmbientPanelWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-bolt";
    this.node.style.overflow = "auto";
    this.node.style.padding = "8px";
    this.node.style.fontSize = "13px";
  }

  @postConstruct()
  protected init(): void {
    this.connectSSE();
  }

  dispose(): void {
    this.sseAbortController?.abort();
    super.dispose();
  }

  addCycleEntry(entry: AmbientCycleEntry): void {
    this.cycles.unshift(entry);
    this.render();
  }

  async approve(requestId: string): Promise<void> {
    try {
      await fetch(`${MIZI_API_BASE}/api/ambient/approve/${requestId}`, { method: "POST" });
      const entry = this.cycles.find((c) => c.timestamp === requestId);
      if (entry) entry.approved = true;
      this.render();
    } catch {
      this.msg.warn("Failed to approve request.");
    }
  }

  async reject(requestId: string): Promise<void> {
    try {
      await fetch(`${MIZI_API_BASE}/api/ambient/reject/${requestId}`, { method: "POST" });
      const entry = this.cycles.find((c) => c.timestamp === requestId);
      if (entry) entry.approved = false;
      this.render();
    } catch {
      this.msg.warn("Failed to reject request.");
    }
  }

  private connectSSE(): void {
    const abort = new AbortController();
    this.sseAbortController = abort;

    const source = new EventSource(`${MIZI_API_BASE}/api/ambient/stream`);
    source.addEventListener("message", (event) => {
      try {
        const entry = JSON.parse(event.data) as AmbientCycleEntry;
        this.addCycleEntry(entry);
      } catch {
        // Ignore parse errors
      }
    });
    source.addEventListener("approval_request", (event) => {
      try {
        const entry = JSON.parse(event.data) as AmbientCycleEntry;
        entry.type = "approval_request";
        this.addCycleEntry(entry);
        this.showNotification(entry);
      } catch {
        // Ignore
      }
    });
    abort.signal.addEventListener("abort", () => source.close());
  }

  private showNotification(entry: AmbientCycleEntry): void {
    const notifMsg = `Ambient needs approval: ${entry.message.substring(0, 100)}`;
    this.msg.info(notifMsg);
  }

  private render(): void {
    const itemsHtml = this.cycles
      .map(
        (entry, i) => `
      <div style="
        border:1px solid var(--theia-editorWidget-border);
        border-left:4px solid ${this.typeColor(entry.type)};
        border-radius:3px;padding:6px 8px;margin-bottom:4px;
        font-size:0.9em;
      ">
        <div style="display:flex;justify-content:space-between;gap:4px">
          <span style="flex:1;font-weight:${entry.type === "approval_request" ? "600" : "400"}">
            ${this.escapeHtml(entry.message)}
          </span>
          <span style="font-size:0.75em;color:var(--theia-descriptionForeground);white-space:nowrap">
            ${this.formatTime(entry.timestamp)}
          </span>
        </div>
        ${entry.details ? `<p style="margin:4px 0;font-size:0.9em;color:var(--theia-descriptionForeground)">${this.escapeHtml(entry.details)}</p>` : ""}
        ${entry.type === "approval_request" && entry.approved === undefined ? `
          <div style="display:flex;gap:8px;margin-top:6px">
            <button data-ambient-action="approve" data-ambient-id="${entry.timestamp}" style="
              background:#4ec9b0;color:#1e1e1e;border:none;border-radius:3px;padding:3px 12px;cursor:pointer;
            ">Approve</button>
            <button data-ambient-action="reject" data-ambient-id="${entry.timestamp}" style="
              background:#f44747;color:white;border:none;border-radius:3px;padding:3px 12px;cursor:pointer;
            ">Reject</button>
          </div>
        ` : entry.approved !== undefined ? `
          <span style="font-size:0.8em;color:${entry.approved ? "#4ec9b0" : "#f44747"}">
            ${entry.approved ? "Approved" : "Rejected"}
          </span>
        ` : ""}
      </div>`
      )
      .join("\n");

    this.node.innerHTML = `
      <h3 style="margin:0 0 8px 0;font-size:1.1em">Ambient Agent</h3>
      ${itemsHtml || "<p style='color:var(--theia-descriptionForeground)'>No activity yet. Ambient agent runs automatically in the background.</p>"}
      <div style="margin-top:12px">
        <button data-ambient-kill style="
          background:var(--theia-errorForeground);color:white;border:none;
          border-radius:3px;padding:4px 16px;cursor:pointer;font-size:0.85em;
        ">Kill Agent</button>
      </div>
    `;

    // Event delegation
    this.node.querySelectorAll("[data-ambient-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const action = (el as HTMLElement).dataset.ambientAction!;
        const id = (el as HTMLElement).dataset.ambientId!;
        if (action === "approve") this.approve(id);
        if (action === "reject") this.reject(id);
      });
    });
    this.node.querySelector("[data-ambient-kill]")?.addEventListener("click", () => {
      fetch(`${MIZI_API_BASE}/api/ambient/stop`, { method: "POST" });
    });
  }

  private typeColor(type: string): string {
    switch (type) {
      case "approval_request": return "#dcdcaa";
      case "action":           return "#4ec9b0";
      case "suggestion":       return "#569cd6";
      case "error":            return "#f44747";
      default:                 return "#808080";
    }
  }

  private formatTime(ts: string): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return "now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    return d.toLocaleTimeString();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
}
