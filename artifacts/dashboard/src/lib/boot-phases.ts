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

/** Provider type — drives which phase ORDER is used by inferBootPhase. */
export type SessionProvider = "vastai" | "nim";

export type BootPhaseStatus = "pending" | "active" | "done" | "error" | "skipped";

export interface BootPhase {
  key: BootPhaseKey;
  label: string;
  status: BootPhaseStatus;
}

/**
 * Structured failure cause emitted by docker/onstart.sh via the instance
 * status callback. The cockpit uses this to render a "Suggested next step"
 * row beneath the failed phase instead of a generic "error" badge.
 *
 * Kept in sync with FAILURE_STATUS_MAP in
 *   artifacts/api-server/src/routes/sessions.ts
 */
export type BootFailureCause =
  | "provisioning_failed"
  | "download_failed"
  | "download_stalled"
  | "vllm_warmup_failed"
  | "skills_compile_failed"
  | "disk_full";

export interface BootFailure {
  cause: BootFailureCause;
  /** The phase the failure should be attached to in the timeline. */
  phaseKey: BootPhaseKey;
  /** Short label for the suggested next step shown in the UI. */
  suggestedStep: string;
  /** Whether the dashboard should offer the "Destroy & Retry" button. */
  destroyAndRetryRecommended: boolean;
}

const FAILURE_TABLE: Record<BootFailureCause, Omit<BootFailure, "cause">> = {
  provisioning_failed:   { phaseKey: "container", suggestedStep: "Container provisioning failed before services came up — destroy this session and retry on a different host.", destroyAndRetryRecommended: true },
  skills_compile_failed: { phaseKey: "skills",    suggestedStep: "Smart Skills bundle failed to compile — re-save the bundle in Settings or clear it for this session, then retry.", destroyAndRetryRecommended: false },
  download_failed:       { phaseKey: "weights",   suggestedStep: "Model weight download failed after retries — check that the model repo exists and HuggingFace is reachable, then destroy and retry.", destroyAndRetryRecommended: true },
  download_stalled:      { phaseKey: "weights",   suggestedStep: "Model download stalled — host network or HuggingFace appears unreachable. Destroy and retry to land on a different host.", destroyAndRetryRecommended: true },
  disk_full:             { phaseKey: "weights",   suggestedStep: "Host ran out of disk space — destroy this session and retry. Vast.ai will pick a different host with sufficient free space.", destroyAndRetryRecommended: true },
  vllm_warmup_failed:    { phaseKey: "llm",       suggestedStep: "vLLM did not come online within the warmup window — VRAM may be insufficient for this profile. Try a smaller quant or larger GPU profile.", destroyAndRetryRecommended: true },
};

/**
 * Parse the structured `boot_failure:<cause> <message>` prefix that
 * onstart.sh emits via report_failure(). Returns null if the message is
 * unstructured (legacy boot or unrelated status line).
 */
export function parseBootFailure(statusMessage: string | null | undefined, allMessages: string[] = []): BootFailure | null {
  const candidates = [statusMessage ?? "", ...allMessages].filter(Boolean) as string[];
  for (const line of candidates) {
    const m = /boot_failure:([a-z_]+)/i.exec(line);
    if (!m) continue;
    const cause = m[1] as BootFailureCause;
    const entry = FAILURE_TABLE[cause];
    if (entry) {
      return { cause, ...entry };
    }
  }
  return null;
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

/** Condensed 3-phase timeline used for NIM (hosted-inference) sessions.
 *  No model download or vLLM warmup — just container → services → LLM proxy. */
const NIM_ORDER: { key: BootPhaseKey; label: string }[] = [
  { key: "container", label: "Container started" },
  { key: "services",  label: "Services started" },
  { key: "llm",       label: "NIM proxy ready" },
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
  provider?: SessionProvider | string | null;
}): BootPhase[] {
  const { status, statusMessage, bootLog = [], provider } = args;
  const isNim = provider === "nim";
  const activeOrder = isNim ? NIM_ORDER : ORDER;
  const allMessages = [...bootLog, statusMessage ?? ""].filter(Boolean) as string[];

  // Build the set of phases that have been observed at any point in the log.
  const observed = new Set<BootPhaseKey>();
  for (const line of allMessages) {
    const k = detectActive(status, line);
    if (k) observed.add(k);
  }

  const activeKey = detectActive(status, statusMessage ?? "");
  let activeIdx = activeKey ? activeOrder.findIndex(p => p.key === activeKey) : -1;

  // Structured-failure override: when onstart.sh emitted a `boot_failure:<cause>`
  // marker, route the error row to the cause's phase regardless of the active
  // keyword. This handles cases like `vllm_warmup_failed` where the literal
  // status line "boot_failure:vllm_warmup_failed ..." doesn't match the
  // legacy lexical heuristics.
  if (status === "error") {
    const failure = parseBootFailure(statusMessage, bootLog);
    if (failure) {
      const idx = activeOrder.findIndex(p => p.key === failure.phaseKey);
      if (idx >= 0) activeIdx = idx;
    }
  }

  // On `error`, the final statusMessage is often a generic failure ("Instance
  // errored", "vast.ai returned 500") that contains no phase keyword. In that
  // case, fall back to the last phase we ever observed in the boot log so the
  // stepper marks the correct row red instead of collapsing to phase 1.
  if (status === "error" && activeIdx <= 0) {
    let lastObservedIdx = -1;
    for (const line of allMessages) {
      const k = detectActive("provisioning", line); // neutral status — pure keyword match
      if (k) {
        const idx = activeOrder.findIndex(p => p.key === k);
        if (idx > lastObservedIdx) lastObservedIdx = idx;
      }
    }
    if (lastObservedIdx >= 0) activeIdx = lastObservedIdx;
  }

  if (status === "ready") {
    return activeOrder.map(p => ({ ...p, status: "done" as BootPhaseStatus }));
  }

  if (status === "stopped") {
    return activeOrder.map((p, i) => ({
      ...p,
      status: (observed.has(p.key) && (activeIdx < 0 || i < activeIdx))
        ? "done"
        : ("skipped" as BootPhaseStatus),
    }));
  }

  return activeOrder.map((p, i) => {
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
