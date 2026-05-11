import { useState, useMemo, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  useGetDashboardSummary,
  useGetActiveSession,
  useListProfiles,
  useCreateSession,
  useListSessions,
  useGetSchedulerConfig,
  getGetDashboardSummaryQueryKey,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import type { Session, GpuProfile } from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { RelaunchButton } from "@/components/relaunch-button";
import { ProfileCard } from "@/components/profile-card";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";
import type { LaunchOptions } from "@/components/launch-session-dialog";
import {
  Sparkles, Loader2, Terminal, ArrowRight,
  GitBranch, Eye, EyeOff, Zap, Cpu, Github,
  ChevronDown, ChevronRight, RotateCcw, X, Globe,
} from "lucide-react";
import { SwarmPill } from "@/components/swarm-activity-panel";
import { useGitHubConnection } from "@/hooks/use-github-connection";
import { GitHubConnectionWidget } from "@/components/github-connection-widget";

// ── helpers ──────────────────────────────────────────────────────────────────

// URL preference (non-sensitive) → localStorage so it persists across sessions
const LS_REPO_URL_KEY = "mizi:last_repo_url";
function loadSavedRepoUrl() {
  try { return localStorage.getItem(LS_REPO_URL_KEY) ?? ""; } catch { return ""; }
}
function saveRepoUrl(url: string) {
  try { url ? localStorage.setItem(LS_REPO_URL_KEY, url) : localStorage.removeItem(LS_REPO_URL_KEY); } catch { /* ignore */ }
}

// PAT (sensitive) → sessionStorage only — ephemeral per browser tab, not persisted
// This limits XSS blast radius vs. localStorage while still providing in-session convenience.
const SS_PAT_PREFIX = "mizi:session_pat:";
function loadSessionPat(url: string) {
  try { return sessionStorage.getItem(SS_PAT_PREFIX + url.trim().toLowerCase()) ?? ""; } catch { return ""; }
}
function saveSessionPat(url: string, token: string) {
  try {
    const key = SS_PAT_PREFIX + url.trim().toLowerCase();
    token ? sessionStorage.setItem(key, token) : sessionStorage.removeItem(key);
  } catch { /* ignore */ }
}
function projectNameFromRepoUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (parts.length === 1) return parts[0];
  } catch { /* fall through */ }
  return trimmed.split("/").pop() || null;
}

const GITHUB_URL_RE = /https?:\/\/(github|gitlab)\.com\/[\w.\-]+\/[\w.\-]+/i;
const REPO_KEYWORD_RE =
  /\b(my repo|existing (repo|project|code|codebase)|working on|add to my|fix in my|in the repo|in my codebase|clone|connect.*repo|pull request|pr review|open pr|my (github|gitlab)|push to|commit to|branch|checkout)\b/i;

// ── types ────────────────────────────────────────────────────────────────────

interface IntentResult {
  path: "nim" | "gpu" | "choice";
  reasoning: string;
  nimSuggestion?: {
    nimModelId: string;
    nimProvider: string | null;
    displayName: string;
    providerLabel: string;
    estimatedStartMin: number;
    description?: string;
  } | null;
  gpuSuggestion?: { tier: string; description: string; estimatedStartMin: number };
  repoSuggestion?: { message: string };
}

type NimSuggestion = NonNullable<IntentResult["nimSuggestion"]>;

interface NimCatalogModel {
  nimModelId: string;
  displayName: string;
  partnerProviders: string[];
  nimTypes: string[];
  shortDescription: string;
}

interface NimProviderHealth {
  key: string;
  displayName: string;
  configured: boolean;
  live: boolean;
  latencyMs: number | null;
}

// ── RepoPanel ────────────────────────────────────────────────────────────────

function RepoPanel({
  repoUrl, setRepoUrl, githubToken, setGithubToken,
}: {
  repoUrl: string; setRepoUrl: (v: string) => void;
  githubToken: string; setGithubToken: (v: string) => void;
}) {
  const [showToken, setShowToken] = useState(false);
  const { status: ghStatus } = useGitHubConnection();

  // Load session-scoped PAT when repo URL changes (sessionStorage — ephemeral, not persisted)
  useEffect(() => {
    if (repoUrl.trim()) {
      const saved = loadSessionPat(repoUrl);
      if (saved && !githubToken) setGithubToken(saved);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl]);

  // Persist URL to localStorage (non-sensitive) and token to sessionStorage (sensitive)
  useEffect(() => { saveRepoUrl(repoUrl); }, [repoUrl]);
  useEffect(() => { if (repoUrl.trim()) saveSessionPat(repoUrl, githubToken); }, [repoUrl, githubToken]);

  return (
    <div
      className="rounded-xl p-4 space-y-3 glass-emerge"
      style={{ background: "rgba(124,111,247,0.06)", border: "1px solid rgba(124,111,247,0.18)" }}
    >
      <div className="flex items-center gap-2">
        <GitBranch className="w-3.5 h-3.5" style={{ color: "var(--accent-violet)" }} />
        <span className="text-xs font-semibold" style={{ color: "var(--accent-violet)" }}>
          Connect your repository
        </span>
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider font-semibold block mb-1.5" style={{ color: "var(--text-muted)" }}>
          Repository URL
        </label>
        <input
          type="url"
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
          placeholder="https://github.com/you/your-repo"
          className="w-full text-xs px-3 py-2 rounded-lg outline-none transition-all"
          style={{
            background: "var(--bg-glass)", border: "1px solid var(--border-glass)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {ghStatus.connected ? (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(16,185,129,0.07)", border: "1px solid rgba(16,185,129,0.18)" }}>
          {ghStatus.avatarUrl && (
            <img src={ghStatus.avatarUrl} alt={ghStatus.login ?? ""} className="w-4 h-4 rounded-full" />
          )}
          <Github className="w-3 h-3 shrink-0" style={{ color: "#10b981" }} />
          <span style={{ color: "#10b981" }}>Connected as <strong>{ghStatus.login}</strong> — token injected at launch</span>
        </div>
      ) : (
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold block mb-1.5" style={{ color: "var(--text-muted)" }}>
            GitHub PAT{" "}
            <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
              (optional — private repos only)
            </span>
          </label>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={githubToken}
              onChange={e => setGithubToken(e.target.value)}
              placeholder="ghp_••••••••••••"
              className="w-full text-xs px-3 py-2 pr-9 rounded-lg outline-none font-mono"
              style={{
                background: "var(--bg-glass)", border: "1px solid var(--border-glass)",
                color: "var(--text-primary)",
              }}
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
          </div>
          {githubToken && repoUrl.trim() && (
            <p className="text-[10px] mt-1" style={{ color: "var(--accent-violet)" }}>
              ✓ Token saved for this repo
            </p>
          )}
          <p className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
            <Github className="w-3 h-3 shrink-0" />
            Or{" "}
            <a href={`${BASE_URL}api/auth/github`} className="underline hover:opacity-80 transition-opacity">
              Connect GitHub once
            </a>{" "}
            to skip this every launch.
          </p>
        </div>
      )}
    </div>
  );
}

// ── IntentBar ────────────────────────────────────────────────────────────────

const TASK_MODES = [
  { value: "build", label: "Build" },
  { value: "review", label: "Review" },
  { value: "debug", label: "Debug" },
  { value: "refactor", label: "Refactor" },
  { value: "explore", label: "Explore" },
  { value: "team", label: "Team" },
] as const;

const TOKEN_MODES = [
  { value: "core", label: "Core", hint: "balanced" },
  { value: "full", label: "Full", hint: "max context" },
  { value: "lean", label: "Lean", hint: "lower cost" },
  { value: "ultra", label: "Ultra", hint: "minimal" },
] as const;

function IntentBar({ onGpuLaunch, onNimLaunch, nimCatalog, nimConfigured, nimHealth }: {
  onGpuLaunch: (profileId: number, opts?: Omit<LaunchOptions, "profileId">) => void;
  onNimLaunch: (opts: {
    nimModelId: string; nimProvider: string;
    intentText?: string; repoUrl?: string | null; githubToken?: string | null;
    taskMode?: string | null; tokenMode?: string | null; skillBundle?: string | null;
  }) => void;
  nimCatalog: NimCatalogModel[];
  nimConfigured: Record<string, boolean>;
  nimHealth: Record<string, NimProviderHealth>;
}) {
  const [, navigate] = useLocation();
  const [intent, setIntent] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [result, setResult] = useState<IntentResult | null>(null);
  const [showRepo, setShowRepo] = useState(false);
  const [repoUrl, setRepoUrl] = useState(() => loadSavedRepoUrl());
  const [githubToken, setGithubToken] = useState(() => repoUrl ? loadSessionPat(repoUrl) : "");
  const { status: ghStatus } = useGitHubConnection();
  const [gpuOpen, setGpuOpen] = useState(false);
  const [launchingNim, setLaunchingNim] = useState(false);
  const [preClassifying, setPreClassifying] = useState(false);
  const [selectedNimSuggestion, setSelectedNimSuggestion] = useState<NimSuggestion | null>(null);
  const [showMoreModels, setShowMoreModels] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [taskMode, setTaskMode] = useState<string>("build");
  const [tokenMode, setTokenMode] = useState<string>("core");
  const [skillBundle, setSkillBundle] = useState<string>("auto");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data: profiles } = useListProfiles();

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [intent]);

  // Auto-detect repo URL or keywords in intent text
  useEffect(() => {
    const urlMatch = intent.match(GITHUB_URL_RE);
    if (urlMatch && !repoUrl) setRepoUrl(urlMatch[0]);
    if (urlMatch || REPO_KEYWORD_RE.test(intent)) setShowRepo(true);
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  // 600ms debounced pre-classification while typing (≥12 chars)
  // Static baseline providers passed to classify so the backend can filter model suggestions.
  // nvidia is always included; additional providers can be added when the catalog exposes a hook.
  const knownProviders = useMemo(() => ["nvidia"], []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (intent.trim().length < 12 || classifying) return;
    debounceRef.current = setTimeout(() => {
      classify(true); // silent pre-warm — shows subtle indicator via preClassifying
    }, 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [intent, repoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const classify = async (silent = false) => {
    if (!intent.trim() || classifying) return;
    if (!silent) setClassifying(true);
    else setPreClassifying(true);
    setResult(null);
    try {
      const r = await fetch(`${BASE_URL}api/intent/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intentText: intent,
          repoUrl: repoUrl || undefined,
          hasGitHubToken: !!githubToken,
          availableProviders: knownProviders,
        }),
      });
      const data: IntentResult = r.ok ? await r.json() : { path: "choice", reasoning: "Could not classify." };
      setResult(data);
      setSelectedNimSuggestion(data.nimSuggestion ?? null);
      setShowMoreModels(false);
      // Show repo panel when classify detects repo context (signalled by repoSuggestion)
      if (data.repoSuggestion) setShowRepo(true);
    } catch {
      if (!silent) setResult({ path: "choice", reasoning: "Could not reach the classify endpoint." });
    } finally {
      if (!silent) setClassifying(false);
      else setPreClassifying(false);
    }
  };

  const handleNimLaunch = () => {
    if (!selectedNimSuggestion || launchingNim) return;
    setLaunchingNim(true);
    onNimLaunch({
      nimModelId: selectedNimSuggestion.nimModelId,
      nimProvider: selectedNimSuggestion.nimProvider ?? "nvidia",
      intentText: intent || undefined,
      repoUrl: repoUrl || null,
      githubToken: ghStatus.connected ? null : (githubToken || null),
      taskMode: taskMode || null,
      tokenMode: tokenMode || null,
      skillBundle: skillBundle !== "auto" ? skillBundle : null,
    });
  };

  const handleGpuLaunch = (profileId: number) => {
    onGpuLaunch(profileId, {
      intentText: intent || undefined,
      repoUrl: repoUrl || null,
      githubToken: ghStatus.connected ? null : (githubToken || null),
      taskMode: taskMode || null,
      tokenMode: tokenMode || null,
      skillBundle: skillBundle !== "auto" ? skillBundle : undefined,
    } as Omit<LaunchOptions, "profileId">);
    setResult(null);
    setIntent("");
  };

  const repoLabel = repoUrl ? (projectNameFromRepoUrl(repoUrl) ?? "Repo") : "Existing repo";
  const hasRepo = showRepo || !!result?.repoSuggestion;
  const isActive = !!intent.trim();

  return (
    <div className="space-y-3">
      {/* Hero field — elevated glass material with inner top highlight */}
      <div
        className="overflow-hidden transition-all duration-300"
        style={{
          borderRadius: "22px",
          background: isActive
            ? "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, transparent 50%), rgba(255,255,255,0.038)"
            : "linear-gradient(145deg, rgba(255,255,255,0.04) 0%, transparent 50%), rgba(255,255,255,0.028)",
          border: `1px solid ${isActive ? "rgba(0,180,216,0.16)" : "var(--border-glass-soft)"}`,
          backdropFilter: "blur(48px) saturate(200%)",
          WebkitBackdropFilter: "blur(48px) saturate(200%)",
          boxShadow: isActive
            ? "inset 0 1px 0 rgba(255,255,255,0.09), 0 8px 40px rgba(0,0,0,0.32), 0 2px 8px rgba(0,0,0,0.2)"
            : "inset 0 1px 0 var(--inner-highlight-sm), 0 4px 24px rgba(0,0,0,0.24)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={intent}
          onChange={e => { setIntent(e.target.value); setResult(null); }}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); classify(); }
          }}
          placeholder="What are you building today?"
          rows={3}
          className="intent-field w-full bg-transparent px-6 pt-6 pb-2 text-base resize-none outline-none leading-relaxed"
          style={{ color: "var(--text-primary)", fontWeight: 400, letterSpacing: "-0.01em" }}
        />

        <div className="flex items-center justify-between px-6 pb-5 mt-1">
          <button
            type="button"
            onClick={() => setShowRepo(v => !v)}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-xl transition-all"
            style={{
              color: hasRepo ? "var(--accent-violet)" : "var(--text-muted)",
              background: hasRepo ? "rgba(124,111,247,0.09)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${hasRepo ? "rgba(124,111,247,0.16)" : "var(--border-glass-ultra)"}`,
            }}
          >
            <GitBranch className="w-3 h-3" />
            {repoUrl ? repoLabel : "Existing repo"}
          </button>

          <button
            onClick={() => classify()}
            disabled={!intent.trim() || classifying}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-35"
            style={{
              background: intent.trim() ? "rgba(0,180,216,0.1)" : "rgba(255,255,255,0.04)",
              color: intent.trim() ? "var(--accent-cyan)" : "var(--text-muted)",
              border: `1px solid ${intent.trim() ? "rgba(0,180,216,0.2)" : "var(--border-glass-ultra)"}`,
              boxShadow: intent.trim() ? "inset 0 1px 0 rgba(255,255,255,0.06)" : "none",
            }}
          >
            {classifying
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Sparkles className="w-3.5 h-3.5" />}
            {classifying ? "Thinking…" : "Ask MIZI"}
          </button>
        </div>
      </div>

      {/* Repo panel */}
      {hasRepo && (
        <RepoPanel
          repoUrl={repoUrl} setRepoUrl={setRepoUrl}
          githubToken={githubToken} setGithubToken={setGithubToken}
        />
      )}

      {/* Advanced panel (progressive disclosure) */}
      <div className="flex items-center justify-between px-0.5">
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center gap-1.5 text-[11px] transition-colors"
          style={{ color: showAdvanced ? "var(--text-secondary)" : "var(--text-muted)", fontWeight: 400 }}
        >
          <ChevronRight className={`w-3 h-3 opacity-50 transition-transform ${showAdvanced ? "rotate-90" : ""}`} />
          Advanced
        </button>
        {preClassifying && (
          <span className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text-muted)", opacity: 0.65 }}>
            <Loader2 className="w-3 h-3 animate-spin" /> reading intent…
          </span>
        )}
      </div>

      {showAdvanced && (
        <div
          className="rounded-2xl px-5 py-4 space-y-4 glass-emerge"
          style={{
            background: "linear-gradient(145deg, rgba(255,255,255,0.03) 0%, transparent 60%), rgba(255,255,255,0.018)",
            border: "1px solid var(--border-glass-soft)",
            boxShadow: "inset 0 1px 0 var(--inner-highlight-sm)",
          }}
        >
          {/* Task mode */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Task mode
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TASK_MODES.map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setTaskMode(m.value)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                  style={{
                    background: taskMode === m.value ? "rgba(0,200,255,0.12)" : "rgba(255,255,255,0.04)",
                    color: taskMode === m.value ? "var(--accent-cyan)" : "var(--text-secondary)",
                    border: `1px solid ${taskMode === m.value ? "rgba(0,200,255,0.25)" : "var(--border-glass)"}`,
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Token mode */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Context window
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TOKEN_MODES.map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setTokenMode(m.value)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                  style={{
                    background: tokenMode === m.value ? "rgba(124,111,247,0.12)" : "rgba(255,255,255,0.04)",
                    color: tokenMode === m.value ? "var(--accent-violet)" : "var(--text-secondary)",
                    border: `1px solid ${tokenMode === m.value ? "rgba(124,111,247,0.25)" : "var(--border-glass)"}`,
                  }}
                >
                  {m.label}
                  <span className="opacity-60">{m.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Skill bundle */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Skill bundle
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { value: "auto", label: "Auto", hint: "MIZI picks" },
                { value: "mizi-builder", label: "Builder", hint: "build focused" },
                { value: "mizi-reviewer", label: "Reviewer", hint: "code review" },
                { value: "mizi-debugger", label: "Debugger", hint: "debug & fix" },
              ].map(b => (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => setSkillBundle(b.value)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                  style={{
                    background: skillBundle === b.value ? "rgba(16,185,129,0.12)" : "rgba(255,255,255,0.04)",
                    color: skillBundle === b.value ? "#10b981" : "var(--text-secondary)",
                    border: `1px solid ${skillBundle === b.value ? "rgba(16,185,129,0.25)" : "var(--border-glass)"}`,
                  }}
                >
                  {b.label}
                  <span className="opacity-60">{b.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Classify result */}
      {result && (
        <div
          className="p-5 glass-emerge space-y-4"
          style={{
            borderRadius: "20px",
            background: "linear-gradient(145deg, rgba(255,255,255,0.038) 0%, transparent 55%), rgba(255,255,255,0.022)",
            border: "1px solid var(--border-glass-soft)",
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            boxShadow: "inset 0 1px 0 var(--inner-highlight-sm), 0 2px 16px rgba(0,0,0,0.22)",
          }}
        >
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
            {result.reasoning}
          </p>

          {result.repoSuggestion && (
            <p className="text-[11px] font-mono px-3 py-2 rounded-xl" style={{ color: "var(--accent-violet)", background: "rgba(124,111,247,0.07)", border: "1px solid rgba(124,111,247,0.12)" }}>
              {result.repoSuggestion.message}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            {/* NIM card */}
            {result.nimSuggestion && selectedNimSuggestion && (
              <div
                className="flex-1 min-w-[200px] rounded-xl p-3.5 space-y-2"
                style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.14)" }}
              >
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5" style={{ color: "#10b981" }} />
                  <span className="text-xs font-semibold" style={{ color: "#10b981" }}>
                    {selectedNimSuggestion.displayName} · ~{selectedNimSuggestion.estimatedStartMin}m
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  via {selectedNimSuggestion.providerLabel}
                </p>
                {selectedNimSuggestion.description && (
                  <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                    {selectedNimSuggestion.description}
                  </p>
                )}

                {/* More models link */}
                {nimCatalog.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowMoreModels(v => !v)}
                    className="text-[11px] transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#10b981")}
                    onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                  >
                    {showMoreModels ? "Hide" : "More models…"}
                  </button>
                )}

                {/* Inline model picker */}
                {showMoreModels && (
                  <div
                    className="mt-1 rounded-lg overflow-y-auto"
                    style={{
                      maxHeight: "160px",
                      background: "rgba(0,0,0,0.18)",
                      border: "1px solid rgba(16,185,129,0.12)",
                    }}
                  >
                    {nimCatalog
                      .filter(m => m.nimModelId !== selectedNimSuggestion.nimModelId)
                      .map(m => {
                        const isFree = m.nimTypes.includes("nim_type_preview");

                        // Determine configured / live state across all relevant providers
                        const relevantProviders = isFree
                          ? ["nvidia"]
                          : m.partnerProviders.length > 0 ? m.partnerProviders : ["nvidia"];

                        // Pick the best provider for launch:
                        // 1) first configured + live, 2) first configured, 3) fallback to first
                        const bestProvider =
                          relevantProviders.find(p => nimConfigured[p] && nimHealth[p]?.live) ??
                          relevantProviders.find(p => nimConfigured[p]) ??
                          relevantProviders[0];

                        const isConfigured = !!nimConfigured[bestProvider];
                        const isLive = isConfigured && !!nimHealth[bestProvider]?.live;

                        const PROVIDER_LABEL_MAP: Record<string, string> = {
                          nvidia: "NVIDIA NIM", vultr: "Vultr",
                          together: "Together AI", deepinfra: "DeepInfra",
                        };
                        const providerKey = isFree ? "nvidia" : bestProvider;
                        const providerLabel = isFree
                          ? "NVIDIA NIM"
                          : (PROVIDER_LABEL_MAP[bestProvider] ?? (bestProvider.charAt(0).toUpperCase() + bestProvider.slice(1)));

                        return (
                          <button
                            key={m.nimModelId}
                            type="button"
                            className="w-full text-left px-3 py-2 transition-colors"
                            style={{
                              borderBottom: "1px solid rgba(255,255,255,0.05)",
                              opacity: isConfigured ? 1 : 0.5,
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.08)")}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                            onClick={() => {
                              setSelectedNimSuggestion({
                                nimModelId: m.nimModelId,
                                nimProvider: providerKey,
                                displayName: m.displayName,
                                providerLabel,
                                estimatedStartMin: 2,
                                description: m.shortDescription,
                              });
                              setShowMoreModels(false);
                            }}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
                                {m.displayName}
                              </span>
                              {isLive && (
                                <span className="flex items-center gap-0.5 text-[9px] font-medium" style={{ color: "#10b981" }}>
                                  <span className="relative flex h-1.5 w-1.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
                                  </span>
                                  Live
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                                via {providerLabel} · ~2m
                              </span>
                              {!isConfigured && (
                                <span
                                  role="link"
                                  tabIndex={0}
                                  onClick={e => { e.stopPropagation(); navigate("/settings"); }}
                                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); navigate("/settings"); } }}
                                  className="text-[9px] underline cursor-pointer transition-colors"
                                  style={{ color: "rgba(16,185,129,0.6)" }}
                                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#10b981")}
                                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(16,185,129,0.6)")}
                                >
                                  Add key
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                  </div>
                )}

                <button
                  onClick={handleNimLaunch}
                  disabled={launchingNim}
                  className="mt-1 w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                  style={{
                    background: "rgba(16,185,129,0.15)", color: "#10b981",
                    border: "1px solid rgba(16,185,129,0.25)",
                  }}
                >
                  {launchingNim
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Zap className="w-3 h-3" />}
                  {launchingNim ? "Launching…" : "Launch session"}
                </button>
              </div>
            )}

            {/* GPU card */}
            {result.gpuSuggestion && (
              <div
                className="flex-1 min-w-[200px] rounded-xl p-3.5 space-y-2"
                style={{ background: "rgba(0,180,216,0.04)", border: "1px solid rgba(0,180,216,0.10)" }}
              >
                <div className="flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5" style={{ color: "var(--accent-cyan)" }} />
                  <span className="text-xs font-medium" style={{ color: "var(--accent-cyan)" }}>
                    GPU · ~{result.gpuSuggestion.estimatedStartMin}m
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  {result.gpuSuggestion.description}
                </p>
                <button
                  onClick={() => setGpuOpen(v => !v)}
                  className="mt-1 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium transition-all"
                  style={{
                    background: "rgba(0,180,216,0.08)", color: "var(--accent-cyan)",
                    border: "1px solid rgba(0,180,216,0.14)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                  }}
                >
                  Choose GPU profile
                  {gpuOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
              </div>
            )}
          </div>

          {/* Profile picker */}
          {gpuOpen && profiles && profiles.length > 0 && (
            <div className="pt-1 glass-emerge">
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                Select GPU Profile
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {profiles.slice(0, 6).map((profile: GpuProfile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    onLaunch={(pId) => handleGpuLaunch(pId)}
                    isLaunching={false}
                    isDefaultLaunch={false}
                    isPinned={false}
                    onTogglePin={() => { }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ActiveSessionBanner ───────────────────────────────────────────────────────

function ActiveSessionBanner({ session, onView }: { session: Session; onView: () => void }) {
  const nim = session as Session & { provider?: string; nimModelId?: string; nimProvider?: string };
  const isNim = nim?.provider === "nim";
  const label = isNim ? (nim?.nimModelId ?? session.profileName) : session.profileName;

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-2xl session-glow-active"
      style={{
        background: "rgba(0,180,216,0.045)",
        border: "1px solid rgba(0,180,216,0.13)",
        backdropFilter: "blur(32px)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 2px 16px rgba(0,0,0,0.24)",
      }}
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
          style={{ background: "var(--accent-cyan)" }} />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5"
          style={{ background: "var(--accent-cyan)" }} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm truncate" style={{ color: "var(--text-primary)" }}>
            {label}
          </span>
          {isNim && nim?.nimProvider && (
            <span className="text-[10px] font-mono" style={{ color: "#10b981" }}>
              via {nim.nimProvider}
            </span>
          )}
          <SessionStatusBadge status={session.status} />
          {session.teamMembers && session.teamMembers.length > 0 && (
            <TeamSessionBadge members={session.teamMembers} />
          )}
          {session.costPerHour != null && (
            <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
              ${session.costPerHour.toFixed(2)}/hr
            </span>
          )}
        </div>
      </div>
      <SwarmPill sessionId={session.id} isReady={session.status === "ready"} />
      <button
        onClick={onView}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg shrink-0 transition-colors"
        style={{
          background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)",
          color: "var(--text-primary)",
        }}
      >
        <Terminal className="w-3.5 h-3.5" />
        Open cockpit
      </button>
    </div>
  );
}

// ── RecentSessionRow — compact single-line list item ─────────────────────────

function RecentSessionRow({ session, onClick }: { session: Session; onClick: () => void }) {
  const ref = session.stoppedAt ? new Date(session.stoppedAt) : new Date(session.createdAt);
  const ago = formatDistanceToNow(ref, { addSuffix: false });
  const nim = session as Session & { provider?: string; nimModelId?: string };
  const isNim = nim?.provider === "nim";
  const label = isNim
    ? (nim?.nimModelId?.split("/").pop() ?? session.profileName)
    : session.profileName;
  const snippet = session.intentText?.trim() ?? null;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left group transition-all"
      style={{ color: "var(--text-primary)" }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.045)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ""; }}
    >
      {/* Type badge */}
      <span
        className="text-[9px] uppercase tracking-wider font-semibold shrink-0 w-5 text-center"
        style={{ color: isNim ? "#10b981" : "var(--text-muted)" }}
      >
        {isNim ? "⚡" : "▣"}
      </span>

      {/* Label */}
      <span
        className="text-xs shrink-0 font-mono"
        style={{ color: "var(--text-muted)", maxWidth: "6rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>

      {/* Intent text — fills remaining space */}
      <span
        className="flex-1 text-xs truncate"
        style={{ color: snippet ? "var(--text-secondary)" : "var(--text-muted)", fontStyle: snippet ? "normal" : "italic" }}
      >
        {snippet ?? "No intent recorded"}
      </span>

      {/* Time + re-launch hint */}
      <span className="text-[10px] shrink-0" style={{ color: "var(--text-muted)", opacity: 0.55 }}>{ago}</span>
      <RotateCcw
        className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-40 transition-opacity"
        style={{ color: "var(--text-secondary)" }}
      />
    </button>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: activeSessionResp, isLoading: isLoadingSession } = useGetActiveSession({
    query: { refetchInterval: 10_000, queryKey: getGetActiveSessionQueryKey() },
  });
  const { data: allSessions } = useListSessions();
  const { data: schedulerConfig } = useGetSchedulerConfig();
  const createSession = useCreateSession();

  // NIM catalog — fetched once at page level, passed down to IntentBar for the "More models…" picker
  const [nimCatalog, setNimCatalog] = useState<NimCatalogModel[]>([]);
  const [nimConfigured, setNimConfigured] = useState<Record<string, boolean>>({});
  const [nimHealth, setNimHealth] = useState<Record<string, NimProviderHealth>>({});
  useEffect(() => {
    function fetchNimCatalog() {
      fetch(`${BASE_URL}api/nim/catalog`)
        .then((r) => r.ok ? r.json() as Promise<{ models: NimCatalogModel[]; configured?: Record<string, boolean> }> : null)
        .then((data) => {
          if (data?.models) setNimCatalog(data.models);
          if (data?.configured) setNimConfigured(data.configured);
        })
        .catch(() => {});
    }
    function fetchNimHealth() {
      fetch(`${BASE_URL}api/nim/health`)
        .then((r) => r.ok ? r.json() as Promise<{ providers: NimProviderHealth[] }> : null)
        .then((data) => {
          if (data?.providers) {
            const map: Record<string, NimProviderHealth> = {};
            for (const p of data.providers) map[p.key] = p;
            setNimHealth(map);
          }
        })
        .catch(() => {});
    }

    fetchNimCatalog();
    fetchNimHealth();

    const interval = setInterval(() => {
      fetchNimCatalog();
      fetchNimHealth();
    }, 60_000);

    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Skill bundles — fetched once to resolve user's chosen bundle slug → numeric bundleId
  const [skillBundleMap, setSkillBundleMap] = useState<Record<string, number>>({});
  useEffect(() => {
    fetch(`${BASE_URL}api/skills/skill-bundles`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { bundles?: Array<{ id: number; slug: string }> } | null) => {
        if (!data?.bundles) return;
        const map: Record<string, number> = {};
        for (const b of data.bundles) map[b.slug] = b.id;
        setSkillBundleMap(map);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGpuLaunch = (profileId: number, opts?: Omit<LaunchOptions, "profileId"> & { skillBundle?: string }) => {
    // Resolve skillBundle slug → numeric bundleId if the user made a specific selection
    const resolvedBundleId = opts?.skillBundle
      ? (skillBundleMap[opts.skillBundle] ?? opts?.bundleId ?? null)
      : (opts?.bundleId ?? null);
    createSession.mutate({
      data: {
        profileId,
        teamMembers: opts?.teamMembers ?? null,
        taskMode: opts?.taskMode ?? null,
        tokenMode: opts?.tokenMode ?? null,
        bundleId: resolvedBundleId,
        repoUrl: opts?.repoUrl ?? null,
        intentText: opts?.intentText ?? null,
        githubToken: opts?.githubToken ?? null,
      },
    }, {
      onSuccess: (session) => {
        const token = (session as typeof session & { ownerToken?: string | null }).ownerToken;
        if (token) sessionStorage.setItem(`nim-owner-token:${session.id}`, token);
        toast({ title: "Session launched", description: "Provisioning GPU…" });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setLocation(`/sessions/${session.id}`);
      },
      onError: (err: Error) => {
        toast({ title: "Launch failed", description: err?.message || "Please try again.", variant: "destructive" });
      },
    });
  };

  const handleNimLaunch = (opts: {
    nimModelId: string; nimProvider: string;
    intentText?: string; repoUrl?: string | null; githubToken?: string | null;
    taskMode?: string | null; tokenMode?: string | null; skillBundle?: string | null;
  }) => {
    // Resolve skillBundle slug → numeric bundleId if the user made a specific selection
    const resolvedBundleId = opts.skillBundle ? (skillBundleMap[opts.skillBundle] ?? null) : null;
    createSession.mutate({
      data: {
        nimModelId: opts.nimModelId,
        nimProvider: opts.nimProvider,
        intentText: opts.intentText ?? null,
        repoUrl: opts.repoUrl ?? null,
        githubToken: opts.githubToken ?? null,
        taskMode: opts.taskMode ?? null,
        tokenMode: opts.tokenMode ?? null,
        bundleId: resolvedBundleId,
      } as Parameters<typeof createSession.mutate>[0]["data"],
    }, {
      onSuccess: (session) => {
        const token = (session as typeof session & { ownerToken?: string | null }).ownerToken;
        if (token) sessionStorage.setItem(`nim-owner-token:${session.id}`, token);
        toast({ title: "NIM session launching", description: "Ready in ~2 minutes." });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        setLocation(`/sessions/${session.id}`);
      },
      onError: (err: Error) => {
        toast({ title: "Launch failed", description: err?.message || "Please try again.", variant: "destructive" });
      },
    });
  };

  const activeSession = activeSessionResp?.session ?? null;

  const recentSessions = useMemo(() => {
    if (!allSessions) return [];
    return [...allSessions]
      .filter(s => s.status === "stopped")
      .sort((a, b) => {
        const ta = a.stoppedAt ? new Date(a.stoppedAt).getTime() : new Date(a.createdAt).getTime();
        const tb = b.stoppedAt ? new Date(b.stoppedAt).getTime() : new Date(b.createdAt).getTime();
        return tb - ta;
      })
      .slice(0, 6);
  }, [allSessions]);

  const stats = [
    { label: "Active", value: summary?.activeSessions ?? 0, color: "#10b981" },
    { label: "Sessions", value: summary?.totalSessions ?? 0, color: "var(--accent-cyan)" },
    { label: "Compute", value: `${(summary?.totalHours ?? 0).toFixed(1)}h`, color: "var(--accent-violet)" },
    { label: "Spent", value: `$${(summary?.totalCost ?? 0).toFixed(2)}`, color: "var(--text-secondary)" },
  ];

  return (
    <div className="min-h-full" style={{ background: "var(--bg-base)" }}>
      {/* Ambient depth glows — kept very subtle, Apple-style barely-visible washes */}
      <div
        className="fixed top-[-200px] right-[-120px] w-[700px] h-[700px] rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(0,180,216,0.028) 0%, transparent 65%)",
          filter: "blur(100px)",
        }}
      />
      <div
        className="fixed bottom-[-120px] left-[60px] w-[550px] h-[550px] rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(124,111,247,0.028) 0%, transparent 65%)",
          filter: "blur(100px)",
        }}
      />

      <div className="relative max-w-2xl mx-auto px-8 py-14 space-y-10">

        {/* Active session banner */}
        {!isLoadingSession && activeSession && (
          <div className="glass-emerge">
            <ActiveSessionBanner
              session={activeSession}
              onView={() => setLocation(`/sessions/${activeSession.id}`)}
            />
          </div>
        )}

        {/* Intent field — hero */}
        <div className="glass-emerge" style={{ animationDelay: "20ms" }}>
          <IntentBar onGpuLaunch={handleGpuLaunch} onNimLaunch={handleNimLaunch} nimCatalog={nimCatalog} nimConfigured={nimConfigured} nimHealth={nimHealth} />
        </div>

        {/* Recent sessions — compact list */}
        {recentSessions.length > 0 && (
          <div className="glass-emerge" style={{ animationDelay: "60ms" }}>
            <div className="flex items-center justify-between mb-2">
              <p
                className="text-[10px] font-medium uppercase tracking-widest"
                style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
              >
                Recent
              </p>
              <button
                onClick={() => setLocation("/sessions")}
                className="flex items-center gap-1 text-[11px] transition-colors"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                All <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-0.5">
              {recentSessions.slice(0, 5).map(s => (
                <RecentSessionRow
                  key={s.id}
                  session={s}
                  onClick={() => setLocation(`/sessions/${s.id}`)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Scheduler status — soft collapsed row */}
        {schedulerConfig && (
          <div className="glass-emerge" style={{ animationDelay: "80ms" }}>
            <button
              type="button"
              onClick={() => setLocation("/settings")}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-xs transition-all"
              style={{
                background: "linear-gradient(145deg, rgba(255,255,255,0.026) 0%, transparent 60%), rgba(255,255,255,0.016)",
                border: "1px solid var(--border-glass-soft)",
                color: schedulerConfig.enabled ? "var(--text-secondary)" : "var(--text-muted)",
                boxShadow: "inset 0 1px 0 var(--inner-highlight-sm)",
              }}
            >
              <Globe className="w-3.5 h-3.5 shrink-0" style={{ color: schedulerConfig.enabled ? "#10b981" : "var(--text-muted)", opacity: 0.8 }} />
              <span className="flex-1 text-left">Scheduled sessions</span>
              <span
                className="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                style={{
                  background: schedulerConfig.enabled ? "rgba(16,185,129,0.08)" : "rgba(255,255,255,0.03)",
                  color: schedulerConfig.enabled ? "#10b981" : "var(--text-muted)",
                  border: `1px solid ${schedulerConfig.enabled ? "rgba(16,185,129,0.14)" : "var(--border-glass-ultra)"}`,
                }}
              >
                {schedulerConfig.enabled ? "Active" : "Off"}
              </span>
              <ChevronRight className="w-3 h-3 opacity-25 shrink-0" />
            </button>
          </div>
        )}

        {/* Stats — airy row */}
        <div className="glass-emerge" style={{ animationDelay: "100ms" }}>
          {isLoadingSummary ? (
            <div className="grid grid-cols-4 gap-3">
              {[1, 2, 3, 4].map(i => <div key={i} className="h-14 rounded-2xl shimmer" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {stats.map(s => (
                <div
                  key={s.label}
                  className="rounded-2xl px-5 py-4"
                  style={{
                    background: "linear-gradient(145deg, rgba(255,255,255,0.032) 0%, transparent 60%), rgba(255,255,255,0.018)",
                    border: "1px solid var(--border-glass-soft)",
                    boxShadow: "inset 0 1px 0 var(--inner-highlight-sm)",
                  }}
                >
                  <p className="text-sm font-semibold" style={{ color: s.color }}>{s.value}</p>
                  <p className="text-[10px] uppercase tracking-widest mt-0.5 font-medium" style={{ color: "var(--text-muted)", letterSpacing: "0.09em" }}>
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
