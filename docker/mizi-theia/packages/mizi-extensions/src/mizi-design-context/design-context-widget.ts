import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";

interface DesignCategory {
  name: string;
  entries: Array<{ title: string; summary: string; source: string }>;
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

  private categories: DesignCategory[] = [];

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
    this.fetchCategories();
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
            (e) => `
          <div style="
            border:1px solid var(--theia-editorWidget-border);
            border-radius:3px;padding:6px 8px;margin-bottom:4px;
            font-size:0.85em;
          ">
            <div style="font-weight:500">${this.esc(e.title)}</div>
            <div style="color:var(--theia-descriptionForeground);font-size:0.9em">
              ${this.esc(e.summary)}
            </div>
            <div style="font-size:0.8em;color:var(--theia-textLink-foreground);margin-top:2px">
              ${this.esc(e.source)}
            </div>
          </div>`
          )
          .join("\n")}
      </div>`
      )
      .join("\n");

    this.node.innerHTML =
      `<h3 style="margin:0 0 8px 0;font-size:1.1em">Design Intelligence</h3>` +
      (html || "<p style='color:var(--theia-descriptionForeground)'>No design context loaded.</p>");
  }

  private esc(t: string): string {
    const d = document.createElement("div");
    d.appendChild(document.createTextNode(t));
    return d.innerHTML;
  }
}
