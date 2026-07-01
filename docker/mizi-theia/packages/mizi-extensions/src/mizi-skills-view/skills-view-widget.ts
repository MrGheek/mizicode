import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { Widget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";
import { MiziMetricsFrontendContribution, MetricsSnapshot } from "../mizi-metrics-contributor/frontend-contribution";
import { MiziVLLMFrontendContribution, VLLMStatus } from "../mizi-vllm-manager/frontend-contribution";

interface SkillBundle {
  id: string;
  name: string;
  description: string;
  version: string;
  active: boolean;
}

interface SkillItem {
  id: number;
  name: string;
  description?: string;
  class?: string;
  enabled: boolean;
  reviewStatus: string | null;
}

interface EvalResult {
  skillName: string;
  metric: string;
  score: number;
  previousScore?: number;
  delta?: number;
}

interface ToolInfo {
  name: string;
  description: string;
  agentCount: number;
}

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

function esc(t: string): string {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(t));
  return d.innerHTML;
}

function sparklineSvg(data: number[], width: number, height: number, color: string): string {
  if (data.length < 2) return "";
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points.join(" ")}"/>
  </svg>`;
}

@injectable()
export class SkillsViewWidget extends Widget {
  static readonly FACTORY_ID = "mizi-skills-view";
  static readonly LABEL = "MIZI Skills & Eval";

  @inject(MessageService) protected readonly msg: MessageService;

  @inject(MiziMetricsFrontendContribution)
  protected readonly metricsContrib: MiziMetricsFrontendContribution;

  @inject(MiziVLLMFrontendContribution)
  protected readonly vllmContrib: MiziVLLMFrontendContribution;

  private bundles: SkillBundle[] = [];
  private skills: SkillItem[] = [];
  private evals: EvalResult[] = [];
  private tools: ToolInfo[] = [];
  private metrics: MetricsSnapshot | null = null;
  private vllmStatus: VLLMStatus | null = null;
  private metricsUnsub: (() => void) | null = null;
  private vllmPollHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.id = SkillsViewWidget.FACTORY_ID;
    this.title.label = SkillsViewWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "fa fa-graduation-cap";
    this.node.style.overflow = "auto";
    this.node.style.padding = "8px";
  }

  @postConstruct()
  protected init(): void {
    this.metrics = this.metricsContrib.current;
    this.metricsUnsub = this.metricsContrib.onData((m) => {
      this.metrics = m;
      this.render();
    });
    this.vllmStatus = this.vllmContrib.status;
    this.vllmPollHandle = setInterval(() => {
      this.vllmStatus = this.vllmContrib.status;
      this.render();
    }, 30_000);

    Promise.all([
      this.fetchBundles(),
      this.fetchSkills(),
      this.fetchEvals(),
      this.fetchTools(),
    ]).catch(() => {});
  }

  dispose(): void {
    if (this.metricsUnsub) this.metricsUnsub();
    if (this.vllmPollHandle) clearInterval(this.vllmPollHandle);
    super.dispose();
  }

  async toggleBundle(bundleId: string): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/bundles/${bundleId}/toggle`, { method: "POST" });
      if (resp.ok) {
        const updated = (await resp.json()) as SkillBundle;
        this.bundles = this.bundles.map((b) => (b.id === bundleId ? updated : b));
        this.render();
      }
    } catch {
      this.msg.warn("Failed to toggle bundle");
    }
  }

  async importSkill(): Promise<void> {
    const url = prompt("Enter skill URL or GitHub repo path:");
    if (!url) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (resp.ok) {
        this.msg.info("Skill imported successfully");
        this.fetchSkills();
      } else {
        const text = await resp.text();
        this.msg.error(`Import failed: ${text}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async toggleSkill(skillId: number, enable: boolean): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/${skillId}/${enable ? "enable" : "disable"}`, { method: "POST" });
      if (resp.ok) {
        this.skills = this.skills.map((s) => (s.id === skillId ? { ...s, enabled: enable } : s));
        this.render();
      }
    } catch {
      this.msg.warn("Failed to toggle skill");
    }
  }

  async reviewSkill(skillId: number, approved: boolean): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/${skillId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      if (resp.ok) {
        this.skills = this.skills.map((s) => (s.id === skillId ? { ...s, reviewStatus: approved ? "approved" : "rejected", enabled: approved } : s));
        this.render();
      }
    } catch {
      this.msg.warn("Failed to review skill");
    }
  }

  private async fetchSkills(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills?limit=50`);
      if (resp.ok) {
        const data = (await resp.json()) as { skills: SkillItem[] };
        this.skills = data.skills ?? [];
      }
    } catch { /* ignore */ }
    this.render();
  }

  private async fetchBundles(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/bundles`);
      if (resp.ok) this.bundles = (await resp.json()) as SkillBundle[];
    } catch { /* ignore */ }
    this.render();
  }

  private async fetchEvals(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/evals/leaderboard`);
      if (resp.ok) this.evals = (await resp.json()) as EvalResult[];
    } catch { /* ignore */ }
    this.render();
  }

  private async fetchTools(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/mcp/tools`);
      if (resp.ok) {
        const data = (await resp.json()) as { tools: Array<{ name: string; description: string }> };
        this.tools = data.tools.map((t) => ({ name: t.name, description: t.description, agentCount: 0 }));
      }
    } catch { /* ignore */ }
    this.render();
  }

  private render(): void {
    const bundlesHtml = this.bundles
      .map(
        (b) => `
      <div style="border:1px solid var(--theia-editorWidget-border);border-left:3px solid ${b.active ? "#4ec9b0" : "#808080"};border-radius:3px;padding:6px 8px;margin-bottom:4px;font-size:0.85em">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="flex:1">
            <span style="font-weight:500">${esc(b.name)}</span>
            <span style="font-weight:400;color:var(--theia-descriptionForeground);font-size:0.85em">v${esc(b.version)}</span>
          </div>
          <a href="#" data-toggle-bundle="${b.id}" style="font-size:0.85em;color:${b.active ? "#f44747" : "#4ec9b0"};white-space:nowrap">${b.active ? "Deactivate" : "Activate"}</a>
        </div>
        <div style="color:var(--theia-descriptionForeground);font-size:0.9em">${esc(b.description)}</div>
      </div>`
      )
      .join("\n");

    const evalsHtml = this.evals
      .map((e) => {
        const deltaColor = e.delta != null ? (e.delta > 0 ? "#4ec9b0" : "#f44747") : "var(--theia-descriptionForeground)";
        return `<div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:4px 8px;margin-bottom:3px;font-size:0.85em;display:flex;gap:8px;align-items:center">
          <span style="flex:1">${esc(e.skillName)}</span>
          <span style="color:var(--theia-descriptionForeground)">${esc(e.metric)}</span>
          <span style="font-weight:500">${e.score.toFixed(1)}</span>
          ${e.delta != null ? `<span style="color:${deltaColor}">${e.delta > 0 ? "+" : ""}${e.delta.toFixed(2)}</span>` : ""}
        </div>`;
      })
      .join("\n");

    const toolsHtml = this.tools.length > 0
      ? this.tools.map((t) => `<div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:4px 8px;margin-bottom:3px;font-size:0.85em">
          <span style="font-weight:500">${esc(t.name)}</span>
          <span style="color:var(--theia-descriptionForeground);font-size:0.9em;margin-left:6px">${esc(t.description)}</span>
        </div>`).join("\n")
      : "<p style='color:var(--theia-descriptionForeground)'>No tools registered yet.</p>";

    const m = this.metrics;
    const metricsHtml = m ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:6px 8px;font-size:0.85em">
        <div style="color:var(--theia-descriptionForeground);font-size:0.8em">GPU Usage</div>
        <div style="font-weight:500">${m.gpuUtilization.toFixed(1)}%</div>
        ${sparklineSvg(m.history.map((h) => h.gpuUtilization), 100, 24, "#4ec9b0")}
      </div>
      <div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:6px 8px;font-size:0.85em">
        <div style="color:var(--theia-descriptionForeground);font-size:0.8em">Tokens/sec</div>
        <div style="font-weight:500">${m.tokensPerSecond.toFixed(1)}</div>
        ${sparklineSvg(m.history.map((h) => h.tokensPerSecond), 100, 24, "#569cd6")}
      </div>
      <div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:6px 8px;font-size:0.85em">
        <div style="color:var(--theia-descriptionForeground);font-size:0.8em">Latency (ms)</div>
        <div style="font-weight:500">${m.latencyMs.toFixed(0)}ms</div>
        ${sparklineSvg(m.history.map((h) => h.latencyMs), 100, 24, "#ce9178")}
      </div>
      <div style="border:1px solid var(--theia-editorWidget-border);border-radius:3px;padding:6px 8px;font-size:0.85em">
        <div style="color:var(--theia-descriptionForeground);font-size:0.8em">Cost</div>
        <div style="font-weight:500">$${m.estimatedCost.toFixed(4)}</div>
        ${sparklineSvg(m.history.map((h) => h.estimatedCost), 100, 24, "#d16969")}
      </div>
    </div>` : "<p style='color:var(--theia-descriptionForeground)'>No metrics data yet.</p>";

    const pendingSkills = this.skills.filter((s) => s.reviewStatus === null || s.reviewStatus === "pending");
    const managedSkills = this.skills.filter((s) => s.reviewStatus !== null && s.reviewStatus !== "pending");

    const pendingHtml = pendingSkills.length > 0 ? pendingSkills.map((s) => `
      <div style="border:1px solid var(--theia-editorWidget-border);border-left:3px solid #dcdcaa;border-radius:3px;padding:6px 8px;margin-bottom:4px;font-size:0.85em">
        <div style="font-weight:500">${esc(s.name)}${s.class ? ` <span style="color:var(--theia-descriptionForeground);font-weight:400">${esc(s.class)}</span>` : ""}</div>
        <div style="color:var(--theia-descriptionForeground);font-size:0.9em">${esc(s.description ?? "")}</div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <a href="#" data-review-skill="${s.id}" data-review-action="approve" style="color:#4ec9b0;font-size:0.85em">Approve</a>
          <a href="#" data-review-skill="${s.id}" data-review-action="reject" style="color:#f44747;font-size:0.85em">Reject</a>
        </div>
      </div>`).join("\n") : "";

    const skillsHtml = managedSkills.length > 0 ? managedSkills.map((s) => `
      <div style="border:1px solid var(--theia-editorWidget-border);border-left:3px solid ${s.enabled ? "#4ec9b0" : "#808080"};border-radius:3px;padding:4px 8px;margin-bottom:3px;font-size:0.85em;display:flex;align-items:center;gap:8px">
        <span style="flex:1;font-weight:500">${esc(s.name)}</span>
        <span style="color:var(--theia-descriptionForeground);font-size:0.8em">${esc(s.class ?? "")}</span>
        <a href="#" data-toggle-skill="${s.id}" data-toggle-enable="${!s.enabled}" style="font-size:0.8em;color:${s.enabled ? "#f44747" : "#4ec9b0"}">${s.enabled ? "Disable" : "Enable"}</a>
      </div>`).join("\n") : "";

    const v = this.vllmStatus;
    const vllmColor = v ? (v.status === "running" ? "#4ec9b0" : v.status === "stopped" ? "#808080" : "#f44747") : "#808080";
    const vllmHtml = `<div style="display:flex;align-items:center;gap:12px;padding:6px 8px;border:1px solid var(--theia-editorWidget-border);border-radius:3px;font-size:0.85em">
      <span style="color:${vllmColor};font-weight:500">● ${esc(v?.status ?? "unknown")}</span>
      <span style="flex:1">${v?.model ? esc(v.model) : "No model loaded"}</span>
      ${v ? `<span style="color:var(--theia-descriptionForeground)">GPU: ${v.gpuUtilization.toFixed(1)}%</span>
      <span style="color:var(--theia-descriptionForeground)">Mem: ${v.memoryUsedMb.toFixed(0)}MB</span>
      <span style="color:var(--theia-descriptionForeground)">${Math.floor(v.uptime)}s</span>` : ""}
    </div>`;

    this.node.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:1em;font-weight:600">Skills & Eval</div>
        <a href="#" data-import-skill style="font-size:0.85em;color:var(--theia-textLink-foreground)">Import</a>
      </div>
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">Skill Bundles (${this.bundles.length})</h3>
        ${bundlesHtml || "<p style='color:var(--theia-descriptionForeground)'>No bundles loaded.</p>"}
      </div>
      ${pendingHtml ? `<div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">Pending Review (${pendingSkills.length})</h3>
        ${pendingHtml}
      </div>` : ""}
      ${skillsHtml ? `<div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">Skills (${managedSkills.length})</h3>
        ${skillsHtml}
      </div>` : ""}
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">Eval Leaderboard</h3>
        ${evalsHtml || "<p style='color:var(--theia-descriptionForeground)'>No eval results yet."}
      </div>
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">Active Tools (${this.tools.length})</h3>
        ${toolsHtml}
      </div>
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">System Metrics</h3>
        ${metricsHtml}
      </div>
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 6px 0;font-size:1em">vLLM</h3>
        ${vllmHtml}
      </div>
    `;
  }

  // Wire up interactive elements after each render
  protected onAfterAttach(): void {
    this.attachHandlers();
  }

  protected onUpdateRequest(): void {
    this.attachHandlers();
  }

  private attachHandlers(): void {
    this.node.querySelectorAll("[data-toggle-bundle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        this.toggleBundle((el as HTMLElement).dataset.toggleBundle!);
      });
    });
    this.node.querySelector("[data-import-skill]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.importSkill();
    });
    this.node.querySelectorAll("[data-toggle-skill]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const id = parseInt((el as HTMLElement).dataset.toggleSkill!, 10);
        const enable = (el as HTMLElement).dataset.toggleEnable === "true";
        this.toggleSkill(id, enable);
      });
    });
    this.node.querySelectorAll("[data-review-skill]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const id = parseInt((el as HTMLElement).dataset.reviewSkill!, 10);
        const approved = (el as HTMLElement).dataset.reviewAction === "approve";
        this.reviewSkill(id, approved);
      });
    });
  }
}
