import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";
import { Emitter } from "@theia/core/lib/common/event";

interface PlanLane {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  description?: string;
  assignee?: string;
}

interface PlanBoardState {
  lanes: PlanLane[];
  goal: string;
  phase: string;
}

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class PlanViewWidget extends Widget {
  static readonly FACTORY_ID = "mizi-plan-view";
  static readonly LABEL = "MIZI Plan Board";

  @inject(MessageService) protected readonly msg: MessageService;

  private board: PlanBoardState = { lanes: [], goal: "", phase: "" };
  private sseAbortController: AbortController | null = null;
  private readonly onDidChangeEmitter = new Emitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    super();
    this.id = PlanViewWidget.FACTORY_ID;
    this.title.label = PlanViewWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-tasks";
    this.node.style.overflow = "auto";
    this.node.style.padding = "12px";
  }

  @postConstruct()
  protected init(): void {
    this.fetchBoard();
    this.connectSSE();
  }

  async loadPlan(planId: string): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/plan/${planId}`);
      if (resp.ok) {
        this.board = (await resp.json()) as PlanBoardState;
        this.render();
        this.onDidChangeEmitter.fire();
      }
    } catch {
      this.msg.warn("Failed to load plan");
    }
  }

  dispose(): void {
    this.disconnectSSE();
    super.dispose();
  }

  private async fetchBoard(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/plan/board`);
      if (resp.ok) {
        this.board = (await resp.json()) as PlanBoardState;
        this.render();
      }
    } catch {
      this.node.innerText = "Failed to load plan board.";
    }
  }

  private connectSSE(): void {
    this.disconnectSSE();
    const abort = new AbortController();
    this.sseAbortController = abort;

    const source = new EventSource(`${MIZI_API_BASE}/api/plan/board/stream`);
    source.addEventListener("message", (event) => {
      try {
        this.board = JSON.parse(event.data) as PlanBoardState;
        this.render();
        this.onDidChangeEmitter.fire();
      } catch {
        // Ignore parse errors
      }
    });
    source.addEventListener("error", () => {
      source.close();
      // Reconnect after 3s
      setTimeout(() => this.connectSSE(), 3000);
    });
    abort.signal.addEventListener("abort", () => source.close());
  }

  private disconnectSSE(): void {
    this.sseAbortController?.abort();
    this.sseAbortController = null;
  }

  private render(): void {
    const lanesHtml = this.board.lanes
      .map(
        (lane) => `
      <div class="mizi-lane" style="
        border:1px solid var(--theia-editorWidget-border);
        border-left:4px solid ${this.statusColor(lane.status)};
        border-radius:4px; padding:8px 12px; margin-bottom:6px;
        display:flex; align-items:center; gap:8px;
      ">
        <span style="flex:1;font-weight:500">${this.escapeHtml(lane.title)}</span>
        <span style="font-size:0.85em;color:var(--theia-descriptionForeground)">
          ${lane.assignee ? this.escapeHtml(lane.assignee) : ""}
        </span>
        <span style="
          font-size:0.75em;text-transform:uppercase;
          color:${this.statusColor(lane.status)};
        ">${lane.status.replace("_", " ")}</span>
      </div>`
      )
      .join("\n");

    this.node.innerHTML = `
      <h3 style="margin:0 0 8px 0">${this.escapeHtml(this.board.goal)}</h3>
      <p style="font-size:0.85em;color:var(--theia-descriptionForeground);margin:0 0 12px 0">
        Phase: ${this.escapeHtml(this.board.phase)} · ${this.board.lanes.length} lanes
      </p>
      ${lanesHtml || "<p style='color:var(--theia-descriptionForeground)'>No lanes yet</p>"}
    `;
  }

  private statusColor(status: string): string {
    switch (status) {
      case "completed":   return "#4ec9b0";
      case "in_progress": return "#569cd6";
      case "blocked":     return "#f44747";
      default:            return "#808080";
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
}
