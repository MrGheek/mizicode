import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";

interface GovernanceStats {
  totalItems: number;
  stalePercentage: number;
  hitRate: number;
  contradictions: number;
}

interface MemoryItem {
  id: string;
  content: string;
  type: string;
  relevanceScore: number;
  timestamp: string;
  source: string;
  pinned: boolean;
  sessionId?: string | null;
}

interface Session {
  id: number;
  label?: string;
}

type SortOrder = "relevance" | "recency";

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class MemoryPanelWidget extends Widget {
  static readonly FACTORY_ID = "mizi-memory-panel";
  static readonly LABEL = "MIZI Memory";

  @inject(MessageService) protected readonly msg: MessageService;

  private memories: MemoryItem[] = [];
  private sessions: Session[] = [];
  private governance: GovernanceStats | null = null;
  private sortOrder: SortOrder = "relevance";
  private searchQuery = "";
  private selectedSessionId = "";
  private sseAbortController: AbortController | null = null;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.id = MemoryPanelWidget.FACTORY_ID;
    this.title.label = MemoryPanelWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-database";
    this.node.style.overflow = "auto";
    this.node.style.padding = "8px";
    this.node.style.fontSize = "13px";
  }

  @postConstruct()
  protected init(): void {
    this.fetchSessions();
    this.fetchMemories();
    this.fetchGovernance();
    this.connectSSE();
  }

  dispose(): void {
    this.sseAbortController?.abort();
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    super.dispose();
  }

  private async fetchGovernance(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/memory/governance-stats`);
      if (resp.ok) {
        this.governance = (await resp.json()) as GovernanceStats;
        this.render();
      }
    } catch { /* ignore */ }
  }

  private async fetchSessions(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/memory/sessions`);
      if (resp.ok) {
        this.sessions = (await resp.json()) as Session[];
      }
    } catch {
      // Non-critical
    }
  }

  private async fetchMemories(): Promise<void> {
    try {
      let url = `${MIZI_API_BASE}/api/mem/observations?limit=50`;
      if (this.searchQuery) {
        url = `${MIZI_API_BASE}/api/mem/observations/search?q=${encodeURIComponent(this.searchQuery)}&limit=50`;
      }
      if (this.selectedSessionId) {
        url += `${this.searchQuery ? "&" : ""}sessionId=${encodeURIComponent(this.selectedSessionId)}`;
      }
      const resp = await fetch(url);
      if (resp.ok) {
        const data = (await resp.json()) as { observations?: MemoryItem[]; results?: MemoryItem[] };
        const items = data.observations ?? data.results ?? [];
        this.memories = items.map((m) => ({ ...m, pinned: false }));
        this.sortMemories();
        this.render();
      }
    } catch {
      this.node.innerText = "Failed to load memories.";
    }
  }

  private connectSSE(): void {
    const abort = new AbortController();
    this.sseAbortController = abort;

    const source = new EventSource(`${MIZI_API_BASE}/api/mem/observations/stream`);
    source.addEventListener("message", () => {
      this.fetchMemories();
    });
    abort.signal.addEventListener("abort", () => source.close());
  }

  async togglePin(memoryId: string): Promise<void> {
    const mem = this.memories.find((m) => m.id === memoryId);
    if (!mem) return;
    mem.pinned = !mem.pinned;
    this.render();
    try {
      await fetch(`${MIZI_API_BASE}/api/mem/observations/${memoryId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: mem.pinned }),
      });
    } catch {
      this.msg.warn("Failed to sync pin state.");
    }
  }

  async suppress(memoryId: string): Promise<void> {
    try {
      await fetch(`${MIZI_API_BASE}/api/mem/observations/${memoryId}`, {
        method: "DELETE",
      });
      this.memories = this.memories.filter((m) => m.id !== memoryId);
      this.render();
    } catch {
      this.msg.warn("Failed to suppress memory.");
    }
  }

  private sortMemories(): void {
    this.memories.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (this.sortOrder === "relevance") return b.relevanceScore - a.relevanceScore;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }

  private render(): void {
    const sessionOptions = `<option value="">All sessions</option>
      ${this.sessions.map((s) => `<option value="${s.id}" ${this.selectedSessionId === String(s.id) ? "selected" : ""}>${this.escapeHtml(s.label || `Session #${s.id}`)}</option>`).join("")}`;

    const gov = this.governance;
    const govHtml = gov ? `<div style="display:flex;gap:10px;margin-bottom:6px;font-size:0.8em;color:var(--theia-descriptionForeground);flex-wrap:wrap">
      <span>Total: ${gov.totalItems}</span>
      <span>Hit rate: ${(gov.hitRate * 100).toFixed(0)}%</span>
      <span style="color:${gov.stalePercentage > 20 ? "#f44747" : "#4ec9b0"}">Stale: ${gov.stalePercentage.toFixed(0)}%</span>
      ${gov.contradictions > 0 ? `<span style="color:#dcdcaa">Conflicts: ${gov.contradictions}</span>` : ""}
    </div>` : "";

    const headerHtml = `
      ${govHtml}
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <input data-search type="text" placeholder="Search memories…" value="${this.escapeHtml(this.searchQuery)}" style="
          flex:1;min-width:120px;font-size:0.85em;
          background:var(--theia-input-background);color:var(--theia-input-foreground);
          border:1px solid var(--theia-input-border);border-radius:3px;padding:3px 6px;
        ">
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:0.9em">Memories (${this.memories.length})</span>
        <select data-sort style="
          font-size:0.85em;background:var(--theia-dropdown-background);
          color:var(--theia-dropdown-foreground);border:1px solid var(--theia-dropdown-border);
          border-radius:3px;padding:2px 4px;
        ">
          <option value="relevance" ${this.sortOrder === "relevance" ? "selected" : ""}>By Relevance</option>
          <option value="recency"   ${this.sortOrder === "recency"   ? "selected" : ""}>By Recency</option>
        </select>
        <select data-session-filter style="
          font-size:0.85em;background:var(--theia-dropdown-background);
          color:var(--theia-dropdown-foreground);border:1px solid var(--theia-dropdown-border);
          border-radius:3px;padding:2px 4px;max-width:140px;
        ">${sessionOptions}</select>
      </div>
    `;

    const itemsHtml = this.memories
      .map(
        (mem) => `
      <div class="mizi-memory-item" data-id="${mem.id}" style="
        border:1px solid var(--theia-editorWidget-border);
        border-left:3px solid ${mem.pinned ? "#4ec9b0" : "#569cd6"};
        border-radius:3px;padding:6px 8px;margin-bottom:4px;
        font-size:0.9em;
      ">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:4px">
          <span style="flex:1;word-break:break-word">${this.escapeHtml(mem.content)}</span>
          <span style="font-size:0.75em;white-space:nowrap;color:var(--theia-descriptionForeground)">
            ${(mem.relevanceScore * 100).toFixed(0)}%
          </span>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;font-size:0.75em">
          <span style="color:var(--theia-descriptionForeground)">${this.escapeHtml(mem.type)}</span>
          <span style="color:var(--theia-descriptionForeground)">·</span>
          <span style="color:var(--theia-descriptionForeground)">${this.formatTime(mem.timestamp)}</span>
          <span style="flex:1"></span>
          <a href="#" data-action="pin" style="color:${mem.pinned ? "#4ec9b0" : "var(--theia-textLink-foreground)"}">
            ${mem.pinned ? "Unpin" : "Pin"}
          </a>
          <a href="#" data-action="suppress" style="color:var(--theia-errorForeground)">Suppress</a>
        </div>
      </div>`
      )
      .join("\n");

    this.node.innerHTML = headerHtml + (itemsHtml || "<p style='color:var(--theia-descriptionForeground)'>No memories yet</p>");

    // Event delegation
    this.node.querySelector("[data-search]")?.addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value;
      if (this.searchTimeout) clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.searchQuery = val;
        this.fetchMemories();
      }, 300);
    });

    this.node.querySelector("[data-sort]")?.addEventListener("change", (e) => {
      this.sortOrder = (e.target as HTMLSelectElement).value as SortOrder;
      this.sortMemories();
      this.render();
    });

    this.node.querySelector("[data-session-filter]")?.addEventListener("change", (e) => {
      this.selectedSessionId = (e.target as HTMLSelectElement).value;
      this.fetchMemories();
    });

    this.node.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const item = (el as HTMLElement).closest(".mizi-memory-item") as HTMLElement;
        const id = item.dataset.id!;
        const action = (el as HTMLElement).dataset.action!;
        if (action === "pin") this.togglePin(id);
        if (action === "suppress") this.suppress(id);
      });
    });
  }

  private formatTime(ts: string): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
}
