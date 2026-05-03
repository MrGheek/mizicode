/**
 * Boot phase inference for cockpit Boot Timeline.
 *
 * The session detail page only sees three signals during boot:
 *   - `session.status` — coarse state machine value
 *   - `session.statusMessage` — current human-readable status line
 *   - `bootLog` — accumulated tail of past statusMessage values (kept locally)
 *
 * `inferBootPhase()` collapses those three signals into a fixed, ordered
 * list of seven phases so the UI can render a deterministic stepper. The
 * mapping is purely lexical — no new API field is required.
 */

export type BootPhaseKey =
  | "container"
  | "ssh"
  | "services"
  | "skills"
  | "indexing"
  | "weights"
  | "llm";

export type BootPhaseStatus = "pending" | "active" | "done" | "error" | "skipped";

export interface BootPhase {
  key: BootPhaseKey;
  label: string;
  status: BootPhaseStatus;
}

const ORDER: { key: BootPhaseKey; label: string }[] = [
  { key: "container", label: "Container started" },
  { key: "ssh",       label: "SSH ready" },
  { key: "services",  label: "Services started" },
  { key: "skills",    label: "Skills loaded" },
  { key: "indexing",  label: "Repo indexing" },
  { key: "weights",   label: "Downloading model weights" },
  { key: "llm",       label: "LLM ready" },
];

function detectActive(status: string, msg: string): BootPhaseKey | null {
  const m = msg.toLowerCase();
  if (status === "ready" || /vllm online|llm ready|session is ready/.test(m)) return "llm";
  if (status === "downloading" || /download(ing)?\s+model|loading model into gpu/.test(m)) return "weights";
  if (/index(ing)?\b|repo[- ]?index|building graph|full[- ]?text index|vector index|summariz/i.test(msg)) return "indexing";
  if (/smart skills|skills compil|skills loaded|skills ready/i.test(msg)) return "skills";
  if (status === "starting" || /tools ready|services? (starting|ready)|services? up/i.test(msg)) return "services";
  if (/ssh (ready|up)|sshd|port 22/i.test(msg)) return "ssh";
  if (status === "provisioning" || /instance (created|booting|created)|finding gpu|provisioning|container started/i.test(msg)) return "container";
  return null;
}

/**
 * Infer the boot timeline phase array given the session and accumulated boot log.
 *
 * Behaviour:
 *   - If `status === "ready"` → all phases are `done`.
 *   - If `status === "error"` → the currently-active (last detected) phase is
 *     marked `error`; earlier phases are `done`; later ones are `pending`.
 *   - If `status === "stopped"` (and not previously ready) → all phases that
 *     were not yet active are `skipped`.
 *   - Otherwise the active phase plus any earlier phases observed in the
 *     boot log are marked appropriately.
 */
export function inferBootPhase(args: {
  status: string;
  statusMessage: string | null | undefined;
  bootLog?: string[];
}): BootPhase[] {
  const { status, statusMessage, bootLog = [] } = args;
  const allMessages = [...bootLog, statusMessage ?? ""].filter(Boolean) as string[];

  // Build the set of phases that have been observed at any point in the log.
  const observed = new Set<BootPhaseKey>();
  for (const line of allMessages) {
    const k = detectActive(status, line);
    if (k) observed.add(k);
  }

  const activeKey = detectActive(status, statusMessage ?? "");
  const activeIdx = activeKey ? ORDER.findIndex(p => p.key === activeKey) : -1;

  if (status === "ready") {
    return ORDER.map(p => ({ ...p, status: "done" as BootPhaseStatus }));
  }

  if (status === "stopped") {
    return ORDER.map((p, i) => ({
      ...p,
      status: (observed.has(p.key) && (activeIdx < 0 || i < activeIdx))
        ? "done"
        : ("skipped" as BootPhaseStatus),
    }));
  }

  return ORDER.map((p, i) => {
    if (status === "error" && activeIdx >= 0 && i === activeIdx) {
      return { ...p, status: "error" as BootPhaseStatus };
    }
    if (activeIdx >= 0) {
      if (i < activeIdx) return { ...p, status: "done" as BootPhaseStatus };
      if (i === activeIdx) return { ...p, status: "active" as BootPhaseStatus };
      return { ...p, status: "pending" as BootPhaseStatus };
    }
    // No phase detected yet — first phase is active, rest pending.
    if (i === 0) return { ...p, status: "active" as BootPhaseStatus };
    return { ...p, status: "pending" as BootPhaseStatus };
  });
}

/** Number of completed phases / total — used by the compact tab-bar progress strip. */
export function bootProgress(phases: BootPhase[]): { done: number; total: number; activeIndex: number } {
  let done = 0;
  let activeIndex = -1;
  phases.forEach((p, i) => {
    if (p.status === "done") done += 1;
    if (p.status === "active" || p.status === "error") activeIndex = i;
  });
  return { done, total: phases.length, activeIndex };
}
