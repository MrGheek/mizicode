import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";

interface DesignEntry {
  title: string;
  summary: string;
  source: string;
  id?: number | string;
  bookmarked?: boolean;
}

interface DesignCategory {
  name: string;
  entries: DesignEntry[];
}

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class DesignContextWidget extends Widget {
  static readonly FACTORY_ID = "mizi-design-context";
  static readonly LABEL = "MIZI Design Context";

  @inject(MessageService) protected readonly msg: MessageService;

  private categories: DesignCategory[] = [];
  private bookmarkedIds: Set<string> = new Set();

  constructor() {
    super();
    this.id = DesignContextWidget.FACTORY_ID;
    this.title.label = DesignContextWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-pencil-ruler";
    this.node.style.overflow = "auto";
    this.node.style.padding = "8px";
  }

  @postConstruct()
  protected init(): void {
    this.fetchBookmarks();
    this.fetchCategories();
  }

  async refresh(): Promise<void> {
    await this.fetchBookmarks();
    await this.fetchCategories();
  }

  async sync(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/sync`, { method: "POST" });
      if (resp.ok) {
        this.msg.info("Design intelligence synced");
        await this.fetchCategories();
      }
    } catch {
      this.msg.warn("Sync failed");
    }
  }

  private async fetchBookmarks(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/bookmarks`);
      if (resp.ok) {
        const data = (await resp.json()) as { bookmarks: Array<{ entryId: string }> };
        this.bookmarkedIds = new Set(data.bookmarks.map((b) => b.entryId));
      }
    } catch { /* ignore */ }
  }

  private async toggleBookmark(entryId: string): Promise<void> {
    const isBookmarked = this.bookmarkedIds.has(entryId);
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/bookmarks`, {
        method: isBookmarked ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (resp.ok) {
        if (isBookmarked) this.bookmarkedIds.delete(entryId);
        else this.bookmarkedIds.add(entryId);
        this.render();
      }
    } catch {
      this.msg.warn("Failed to toggle bookmark");
    }
  }

  private async fetchCategories(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/categories`);
      if (resp.ok) {
        this.categories = (await resp.json()) as DesignCategory[];
        this.render();
      }
    } catch {
      this.node.innerText = "Failed to load design context.";
    }
  }

  private render(): void {
    const html = this.categories
      .map(
        (cat) => `
      <div style="margin-bottom:12px">
        <h4 style="margin:0 0 4px 0;font-size:1em">${this.esc(cat.name)} (${cat.entries.length})</h4>
        ${cat.entries
          .map(
            (e) => {
            const entryId = String(e.id ?? `${cat.name}:${e.title}`);
            const isBookmarked = this.bookmarkedIds.has(entryId);
            return `
          <div style="
            border:1px solid var(--theia-editorWidget-border);
            border-left:3px solid ${isBookmarked ? "#4ec9b0" : "var(--theia-editorWidget-border)"};
            border-radius:3px;padding:6px 8px;margin-bottom:4px;
            font-size:0.85em;
          ">
            <div style="display:flex;justify-content:space-between;align-items:start;gap:4px">
              <div style="font-weight:500;flex:1">${this.esc(e.title)}</div>
              <a href="#" data-bookmark="${entryId}" style="font-size:0.85em;color:${isBookmarked ? "#4ec9b0" : "var(--theia-textLink-foreground)"};white-space:nowrap">${isBookmarked ? "Bookmarked" : "Bookmark"}</a>
            </div>
            <div style="color:var(--theia-descriptionForeground);font-size:0.9em">
              ${this.esc(e.summary)}
            </div>
            <div style="font-size:0.8em;color:var(--theia-textLink-foreground);margin-top:2px">
              ${this.esc(e.source)}
            </div>
          </div>`;}
          )
          .join("\n")}
      </div>`
      )
      .join("\n");

    this.node.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;font-size:1.1em">Design Intelligence</h3>
        <a href="#" data-sync-design style="font-size:0.85em;color:var(--theia-textLink-foreground)">Sync</a>
      </div>` +
      (html || "<p style='color:var(--theia-descriptionForeground)'>No design context loaded.</p>") +
      `<div style="margin-top:8px;font-size:0.8em;color:var(--theia-descriptionForeground)">${this.bookmarkedIds.size} bookmarked</div>`;

    this.node.querySelectorAll("[data-bookmark]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        this.toggleBookmark((el as HTMLElement).dataset.bookmark!);
      });
    });
    this.node.querySelector("[data-sync-design]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.sync();
    });
  }

  private esc(t: string): string {
    const d = document.createElement("div");
    d.appendChild(document.createTextNode(t));
    return d.innerHTML;
  }
}
