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

interface AmbientConfig {
  enabled: boolean;
  tokenBudget?: number;
  gpuBudget?: number;
  wallClockBudget?: number;
  allowedKinds?: string[];
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
  private history: AmbientCycleEntry[] = [];
  private sseAbortController: AbortController | null = null;
  private config: AmbientConfig | null = null;
  private showHistory = false;
  private historyOffset = 0;
  private historyLimit = 20;

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
    this.fetchConfig();
    this.fetchHistory();
    this.connectSSE();
  }

  dispose(): void {
    this.sseAbortController?.abort();
    super.dispose();
  }

  private async fetchConfig(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/config`);
      if (resp.ok) {
        this.config = (await resp.json()) as AmbientConfig;
        this.render();
      }
    } catch {
      // Non-critical
    }
  }

  private async fetchHistory(append = false): Promise<void> {
    try {
      const offset = append ? this.historyOffset : 0;
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/cycles?limit=${this.historyLimit}&offset=${offset}`);
      if (resp.ok) {
        const data = (await resp.json()) as { cycles: AmbientCycleEntry[] };
        if (append) {
          this.history = [...this.history, ...(data.cycles ?? [])];
          this.historyOffset += (data.cycles ?? []).length;
        } else {
          this.history = data.cycles ?? [];
          this.historyOffset = (data.cycles ?? []).length;
        }
        if (this.showHistory) this.render();
      }
    } catch { /* ignore */ }
  }

  private async editConfigInWidget(): Promise<void> {
    const tokenBudget = prompt("Token budget:", String(this.config?.tokenBudget ?? ""));
    if (tokenBudget === null) return;
    const gpuBudget = prompt("GPU budget ($):", String(this.config?.gpuBudget ?? ""));
    if (gpuBudget === null) return;
    const wallClock = prompt("Wall clock budget (minutes):", String(this.config?.wallClockBudget ?? ""));
    if (wallClock === null) return;

    const newConfig: AmbientConfig = {
      enabled: this.config?.enabled ?? true,
      tokenBudget: parseInt(tokenBudget) || 0,
      gpuBudget: parseFloat(gpuBudget) || 0,
      wallClockBudget: parseInt(wallClock) || 0,
      allowedKinds: this.config?.allowedKinds,
    };

    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      if (resp.ok) {
        this.config = (await resp.json()) as AmbientConfig;
        this.addCycleEntry({
          type: "system",
          message: "Ambient config updated",
          timestamp: new Date().toISOString(),
        });
        this.render();
      } else {
        this.msg.warn("Failed to update config");
      }
    } catch {
      this.msg.warn("Error updating config");
    }
  }

  private async toggleEnabled(): Promise<void> {
    const newEnabled = !this.config?.enabled;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(this.config ?? {}), enabled: newEnabled }),
      });
      if (resp.ok) {
        this.config = (await resp.json()) as AmbientConfig;
        this.addCycleEntry({
          type: "system",
          message: `Ambient agent ${newEnabled ? "enabled" : "disabled"} by user`,
          timestamp: new Date().toISOString(),
        });
        this.render();
      }
    } catch {
      this.msg.warn("Failed to toggle ambient agent");
    }
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

    const configSummary = this.config
      ? `<div style="font-size:0.75em;margin:4px 0 8px 0;color:var(--theia-descriptionForeground);display:flex;gap:8px;flex-wrap:wrap">
          <span>Tokens: ${this.config.tokenBudget?.toLocaleString() ?? "—"}</span>
          <span>GPU: $${this.config.gpuBudget?.toFixed(2) ?? "—"}</span>
          <span>Budget: ${this.config.wallClockBudget ? `${this.config.wallClockBudget}m` : "—"}</span>
        </div>`
      : "";

    const historyHtml = this.showHistory && this.history.length > 0
      ? this.history.map((entry) => `
        <div style="border:1px solid var(--theia-editorWidget-border);border-left:4px solid ${this.typeColor(entry.type)};border-radius:3px;padding:4px 8px;margin-bottom:3px;font-size:0.8em">
          <div style="display:flex;justify-content:space-between;gap:4px">
            <span style="flex:1">${this.escapeHtml(entry.message)}</span>
            <span style="color:var(--theia-descriptionForeground);white-space:nowrap">${this.formatTime(entry.timestamp)}</span>
          </div>
        </div>`).join("\n")
      : "";

    this.node.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px 0;flex-wrap:wrap;gap:6px">
        <h3 style="margin:0;font-size:1.1em">Ambient Agent</h3>
        <span style="font-size:0.8em;padding:2px 8px;border-radius:3px;background:${this.config?.enabled ? "#4ec9b0" : "var(--theia-descriptionForeground)"};color:#1e1e1e">
          ${this.config?.enabled ? "Active" : "Disabled"}
        </span>
      </div>
      ${configSummary}
      ${itemsHtml || "<p style='color:var(--theia-descriptionForeground)'>No activity yet. Ambient agent runs automatically in the background.</p>"}
      <div style="margin-top:8px">
        <a href="#" data-toggle-history style="font-size:0.85em;color:var(--theia-textLink-foreground)">${this.showHistory ? "Hide" : "Show"} history (${this.history.length})</a>
      </div>
      ${this.showHistory ? `<div style="margin-top:6px">${historyHtml || "<p style='color:var(--theia-descriptionForeground);font-size:0.85em'>No history available</p>"}</div>` : ""}
      ${this.showHistory && this.history.length >= this.historyLimit ? `<div style="margin-top:4px"><a href="#" data-load-more-history style="font-size:0.85em;color:var(--theia-textLink-foreground)">Load more…</a></div>` : ""}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button data-ambient-toggle style="
          background:${this.config?.enabled ? "#f44747" : "#4ec9b0"};color:white;border:none;
          border-radius:3px;padding:4px 16px;cursor:pointer;font-size:0.85em;
        ">${this.config?.enabled ? "Disable" : "Enable"}</button>
        <button data-ambient-kill style="
          background:var(--theia-errorForeground);color:white;border:none;
          border-radius:3px;padding:4px 16px;cursor:pointer;font-size:0.85em;
        ">Kill Agent</button>
        <button data-ambient-config style="
          background:var(--theia-dropdown-background);color:var(--theia-dropdown-foreground);border:1px solid var(--theia-dropdown-border);
          border-radius:3px;padding:4px 16px;cursor:pointer;font-size:0.85em;
        ">Config</button>
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
    this.node.querySelector("[data-ambient-toggle]")?.addEventListener("click", () => {
      this.toggleEnabled();
    });
    this.node.querySelector("[data-ambient-kill]")?.addEventListener("click", () => {
      fetch(`${MIZI_API_BASE}/api/ambient/stop`, { method: "POST" });
      this.addCycleEntry({ type: "system", message: "Ambient agent killed by user", timestamp: new Date().toISOString() });
    });
    this.node.querySelector("[data-ambient-config]")?.addEventListener("click", () => {
      this.editConfigInWidget();
    });
    this.node.querySelector("[data-toggle-history]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.showHistory = !this.showHistory;
      if (this.showHistory && this.history.length === 0) {
        this.fetchHistory();
      } else {
        this.render();
      }
    });
    this.node.querySelector("[data-load-more-history]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.fetchHistory(true);
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
