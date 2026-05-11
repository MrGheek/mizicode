import { useState, useEffect, useRef } from "react";
import {
  useCompileBundle,
  useListSkillBundles,
} from "@workspace/api-client-react";
import type { GpuProfile, CompiledBundleResult } from "@workspace/api-client-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Loader2, ChevronDown, ChevronRight, Wand2, Info,
  Users, Plus, X, Play, Eye, EyeOff, KeyRound, Github, Lock, ChevronsUpDown, Check,
} from "lucide-react";
import { SkillClassBadge } from "@/components/skill-badges";
import { useGitHubConnection } from "@/hooks/use-github-connection";
import { useGitHubRepos } from "@/hooks/use-github-repos";
import { API_BASE_URL } from "@/lib/api-url";

function buildOAuthUrl(): string {
  const base = `${API_BASE_URL}api/auth/github`;
  try {
    // Add launch=open to the return_to URL so the hook can re-open the dialog
    // after the OAuth round-trip completes.
    const returnToUrl = new URL(window.location.href);
    returnToUrl.searchParams.set("launch", "open");
    return `${base}?return_to=${encodeURIComponent(returnToUrl.toString())}`;
  } catch {
    return base;
  }
}

const LS_PAT_PREFIX = "mizi:github_pat:";

function loadSavedPat(repoUrl: string): string {
  if (!repoUrl.trim()) return "";
  try {
    return localStorage.getItem(LS_PAT_PREFIX + repoUrl.trim().toLowerCase()) ?? "";
  } catch {
    return "";
  }
}

function savePat(repoUrl: string, token: string) {
  if (!repoUrl.trim()) return;
  try {
    const key = LS_PAT_PREFIX + repoUrl.trim().toLowerCase();
    if (token) {
      localStorage.setItem(key, token);
    } else {
      localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}

export interface LaunchOptions {
  profileId: number;
  taskMode?: string | null;
  tokenMode?: string | null;
  bundleId?: number | null;
  repoUrl?: string | null;
  intentText?: string | null;
  teamMembers?: string[];
  githubToken?: string | null;
}

export interface LaunchPrefill {
  taskMode?: string | null;
  tokenMode?: string | null;
  bundleId?: number | null;
  repoUrl?: string | null;
  intentText?: string | null;
  teamMemberNames?: string[];
  sourceSessionId?: number;
}

interface LaunchSessionDialogProps {
  profile: GpuProfile;
  onConfirm: (opts: LaunchOptions) => void;
  onClose: () => void;
  isLaunching?: boolean;
  prefill?: LaunchPrefill | null;
}

const TASK_MODES = [
  { value: "build",   label: "Build",   desc: "Writing new features and code" },
  { value: "review",  label: "Review",  desc: "Code review and quality checks" },
  { value: "debug",   label: "Debug",   desc: "Finding and fixing issues" },
  { value: "refactor",label: "Refactor",desc: "Restructuring existing code" },
  { value: "explore", label: "Explore", desc: "Research and experimentation" },
  { value: "team",    label: "Team",    desc: "Collaborative multi-user session" },
];

const TOKEN_MODES = [
  { value: "full",  label: "Full",  desc: "Maximum context, highest cost" },
  { value: "core",  label: "Core",  desc: "Balanced context and efficiency" },
  { value: "lean",  label: "Lean",  desc: "Reduced overhead, lower cost" },
  { value: "ultra", label: "Ultra", desc: "Minimal context, lowest cost" },
];

type CompiledSkillItem = {
  id?: string | number;
  manifestId?: string;
  name?: string;
  class?: string;
  summary?: string;
};

type ReasoningType = {
  task?: string;
  repo?: string;
  model?: string;
  tokenMode?: string;
  intent?: string;
  [key: string]: unknown;
};

export function LaunchSessionDialog({
  profile,
  onConfirm,
  onClose,
  isLaunching,
  prefill,
}: LaunchSessionDialogProps) {
  const hasPrefill = !!prefill;
  const { status: ghStatus } = useGitHubConnection();
  const { repos, loading: reposLoading } = useGitHubRepos(ghStatus.connected);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [manualUrlMode, setManualUrlMode] = useState(() => !!(prefill?.repoUrl));
  const [taskMode, setTaskMode] = useState(() => prefill?.taskMode || "build");
  const [tokenMode, setTokenMode] = useState(() => prefill?.tokenMode || "core");
  const [repoUrl, setRepoUrl] = useState(() => prefill?.repoUrl ?? "");
  const [githubToken, setGithubToken] = useState(() => loadSavedPat(prefill?.repoUrl ?? ""));
  const [showToken, setShowToken] = useState(false);
  const [intentText, setIntentText] = useState(() => prefill?.intentText ?? "");
  // Track whether the user has manually edited the intent so we never
  // overwrite their text with a repo-URL-derived suggestion. When pre-filling
  // from a previous session we treat the existing intent as user-authored so
  // it isn't replaced by the auto-suggestion based on the repo URL.
  const intentEditedRef = useRef<boolean>(!!(prefill?.intentText));

  // Auto-fill a sensible default intent based on the repo URL when the user
  // hasn't typed anything yet (or has cleared the field). We extract the
  // owner/repo from the URL and only suggest a string of the form
  // "Index and explore `owner/repo`".
  useEffect(() => {
    if (intentEditedRef.current) return;
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setIntentText("");
      return;
    }
    const match = trimmed.match(/[/:]([^/\s]+)\/([^/\s.]+)(?:\.git)?\/?$/);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      setIntentText(`Index and explore \`${owner}/${repo}\``);
    }
  }, [repoUrl]);

  // When repoUrl changes, load any saved PAT for that repo.
  const prevRepoUrl = useRef(repoUrl);
  useEffect(() => {
    if (repoUrl === prevRepoUrl.current) return;
    prevRepoUrl.current = repoUrl;
    const saved = loadSavedPat(repoUrl);
    setGithubToken(saved);
  }, [repoUrl]);

  // Persist PAT to localStorage whenever it changes (keyed by repoUrl).
  useEffect(() => {
    savePat(repoUrl, githubToken);
  }, [repoUrl, githubToken]);

  const [bundleOverride, setBundleOverride] = useState<number | null | "none">(
    () => (prefill?.bundleId != null ? prefill.bundleId : null)
  );
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const initialTeam = prefill?.teamMemberNames && prefill.teamMemberNames.length > 0
    ? prefill.teamMemberNames
    : [""];
  const [teamOpen, setTeamOpen] = useState(() => (prefill?.teamMemberNames?.length ?? 0) > 0);
  const [memberNames, setMemberNames] = useState<string[]>(initialTeam);
  const [recommendedBundle, setRecommendedBundle] = useState<CompiledBundleResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const compileBundle = useCompileBundle();
  const { data: bundlesData } = useListSkillBundles();
  const bundles = bundlesData?.bundles ?? [];

  const compileRecommendation = () => {
    compileBundle.mutate({
      data: {
        taskMode,
        tokenMode,
        modelProfile: profile.name,
        repoUrl: repoUrl.trim() || undefined,
        intentText: intentText.trim() || undefined,
      },
    }, {
      onSuccess: (result) => setRecommendedBundle(result),
      onError: () => setRecommendedBundle(null),
    });
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(compileRecommendation, 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [taskMode, tokenMode, profile.id, repoUrl, intentText]);

  const addMember = () => {
    if (memberNames.length < 4) setMemberNames(prev => [...prev, ""]);
  };
  const removeMember = (i: number) => setMemberNames(prev => prev.filter((_, idx) => idx !== i));
  const updateMember = (i: number, val: string) => setMemberNames(prev => prev.map((n, idx) => idx === i ? val : n));

  const handleConfirm = () => {
    const validTeam = teamOpen ? memberNames.map(n => n.trim()).filter(Boolean) : [];
    onConfirm({
      profileId: profile.id,
      taskMode,
      tokenMode,
      bundleId: bundleOverride === "none" ? null : (bundleOverride ?? recommendedBundle?.bundleId ?? null),
      repoUrl: repoUrl.trim() || null,
      intentText: intentText.trim() || null,
      teamMembers: validTeam.length > 0 ? validTeam : undefined,
      githubToken: ghStatus.connected ? null : (githubToken.trim() || null),
    });
  };

  const displayedBundle = bundleOverride === "none"
    ? null
    : bundleOverride != null
      ? bundles.find(b => b.id === bundleOverride) ?? null
      : recommendedBundle;

  const skillsToShow: CompiledSkillItem[] = bundleOverride == null
    ? ((recommendedBundle?.skills ?? []) as CompiledSkillItem[])
    : [];

  const reasoning = (recommendedBundle?.reasoning ?? {}) as ReasoningType;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="w-4 h-4 text-primary" fill="currentColor" />
            {hasPrefill ? `Re-launch: ${profile.displayName}` : `Launch: ${profile.displayName}`}
          </DialogTitle>
          <p className="text-xs text-muted-foreground font-mono">
            {profile.gpuName} x{profile.numGpus} · ${profile.estimatedCostMin.toFixed(2)}-${profile.estimatedCostMax.toFixed(2)}/hr
          </p>
        </DialogHeader>

        {hasPrefill && (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90 flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <span>
              Pre-filled from session
              {prefill?.sourceSessionId ? ` #${prefill.sourceSessionId}` : ""}
              {" "}— edit anything below to customise before launching.
            </span>
          </div>
        )}

        <div className="space-y-5 py-2">
          {/* Repo URL — comes first because it auto-suggests session intent. */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              Repo
              <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
            </Label>

            {ghStatus.connected && !manualUrlMode ? (
              <>
                <Popover open={repoPickerOpen} onOpenChange={setRepoPickerOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 h-9 rounded-md border border-input bg-background px-3 text-sm text-left hover:bg-accent/30 transition-colors"
                    >
                      <span className={repoUrl ? "font-mono text-foreground truncate" : "text-muted-foreground"}>
                        {repoUrl
                          ? (repos.find(r => r.cloneUrl === repoUrl)?.fullName ?? repoUrl)
                          : "Select a repo…"}
                      </span>
                      {reposLoading
                        ? <Loader2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground animate-spin" />
                        : <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search repos…" className="h-9 text-sm" />
                      <CommandList>
                        <CommandEmpty>No repos found.</CommandEmpty>
                        {(() => {
                          const grouped = repos.reduce<Record<string, typeof repos>>((acc, repo) => {
                            const key = repo.owner;
                            if (!acc[key]) acc[key] = [];
                            acc[key].push(repo);
                            return acc;
                          }, {});
                          const owners = Object.keys(grouped).sort();
                          return owners.map(owner => (
                            <CommandGroup key={owner} heading={owner}>
                              {grouped[owner].map(repo => (
                                <CommandItem
                                  key={repo.fullName}
                                  value={repo.fullName}
                                  onSelect={() => {
                                    setRepoUrl(repo.cloneUrl);
                                    setRepoPickerOpen(false);
                                  }}
                                >
                                  <Check className={`w-3.5 h-3.5 shrink-0 ${repoUrl === repo.cloneUrl ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs truncate flex-1">{repo.name}</span>
                                  {repo.private
                                    ? <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70 shrink-0"><Lock className="w-2.5 h-2.5" />Private</span>
                                    : <span className="text-[10px] text-muted-foreground/50 shrink-0">Public</span>}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          ));
                        })()}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3 shrink-0" />
                    Used to recommend the best skill bundle for your repo
                  </p>
                  <button
                    type="button"
                    onClick={() => setManualUrlMode(true)}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline transition-colors"
                  >
                    Enter URL manually
                  </button>
                </div>
              </>
            ) : (
              <>
                <Input
                  placeholder="https://github.com/org/repo"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  className="text-sm font-mono"
                />
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3 shrink-0" />
                    Used to recommend the best skill bundle for your repo
                  </p>
                  {ghStatus.connected && manualUrlMode && (
                    <button
                      type="button"
                      onClick={() => setManualUrlMode(false)}
                      className="text-[10px] text-muted-foreground hover:text-foreground underline transition-colors"
                    >
                      Pick from repos
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* GitHub Token — show PAT field only when no OAuth token is stored */}
          {ghStatus.connected ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
              {ghStatus.avatarUrl && (
                <img src={ghStatus.avatarUrl} alt={ghStatus.login ?? ""} className="w-4 h-4 rounded-full" />
              )}
              <Github className="w-3.5 h-3.5 shrink-0" />
              <span>GitHub connected as <strong>{ghStatus.login}</strong> — token injected automatically</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="w-3 h-3" />
                GitHub Token
                <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
              </Label>
              <div className="relative">
                <Input
                  type={showToken ? "text" : "password"}
                  placeholder="ghp_••••••••••••••••••••••••••••••••••••••"
                  value={githubToken}
                  onChange={e => setGithubToken(e.target.value)}
                  className="text-sm font-mono pr-9"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3 shrink-0" />
                {githubToken && repoUrl.trim()
                  ? "Token saved for this repo — pre-fills next time. Pushes go to mizi/session branch."
                  : "Stored locally per repo — never sent to our servers. Pushes always go to a new branch."}
              </p>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Github className="w-3 h-3 shrink-0" />
                Or{" "}
                <a href={buildOAuthUrl()} className="underline hover:text-foreground transition-colors">
                  Connect GitHub once
                </a>{" "}
                to skip entering tokens every launch.
              </p>
            </div>
          )}

          {/* Session intent — what are you working on? */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              What are you working on?
              <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
            </Label>
            <Textarea
              placeholder="e.g. Add Stripe checkout to the billing page, or refactor the auth middleware to support API keys"
              value={intentText}
              onChange={e => {
                intentEditedRef.current = true;
                setIntentText(e.target.value.slice(0, 500));
              }}
              rows={3}
              className="text-sm resize-none"
            />
            <p className="text-[10px] text-muted-foreground flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Info className="w-3 h-3 shrink-0" />
                Seeded as the opening memory note and shown as your session goal
              </span>
              <span className="font-mono opacity-60">{intentText.length}/500</span>
            </p>
          </div>

          {/* Task Mode */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Task Mode</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {TASK_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => setTaskMode(m.value)}
                  className={`text-left px-2.5 py-2 rounded border text-xs transition-colors ${
                    taskMode === m.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <div className="font-semibold">{m.label}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Token Mode */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Token Mode</Label>
            <div className="flex gap-1">
              {TOKEN_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => setTokenMode(m.value)}
                  title={m.desc}
                  className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors border ${
                    tokenMode === m.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {TOKEN_MODES.find(m => m.value === tokenMode)?.desc}
            </p>
          </div>

          {/* Recommended Bundle */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Wand2 className="w-3.5 h-3.5 text-primary" />
              Recommended Bundle
              {compileBundle.isPending && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </Label>

            {bundleOverride === "none" ? (
              <div className="px-3 py-2 rounded border border-border/40 bg-secondary/20 text-sm text-muted-foreground">
                No Skills (bundle disabled for this session)
              </div>
            ) : displayedBundle != null && "name" in displayedBundle ? (
              <div className="px-3 py-2.5 rounded border border-primary/30 bg-primary/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{(displayedBundle as { name: string }).name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {skillsToShow.length > 0 ? `${skillsToShow.length} skills` : "selected"}
                  </Badge>
                </div>
                {skillsToShow.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {skillsToShow.map((s, i) => (
                      s.class ? (
                        <span key={s.id ?? i} title={s.name ?? String(s.id)}>
                          <SkillClassBadge skillClass={s.class} />
                        </span>
                      ) : null
                    ))}
                  </div>
                )}
              </div>
            ) : compileBundle.isPending ? (
              <div className="px-3 py-2 rounded border border-border/40 bg-secondary/20 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Calculating best bundle…
              </div>
            ) : (
              <div className="px-3 py-2 rounded border border-border/40 bg-secondary/20 text-sm text-muted-foreground">
                No bundle recommended
              </div>
            )}

            {/* Explain why collapsible */}
            {bundleOverride == null && recommendedBundle && Object.keys(reasoning).length > 0 && (
              <button
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setReasoningExpanded(v => !v)}
              >
                {reasoningExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Explain why
              </button>
            )}
            {reasoningExpanded && reasoning && (
              <div className="rounded border border-border/40 bg-secondary/20 p-2.5 space-y-1 text-xs">
                {reasoning.task && <p><span className="text-muted-foreground">Task match:</span> {reasoning.task}</p>}
                {reasoning.repo && <p><span className="text-muted-foreground">Repo match:</span> {reasoning.repo}</p>}
                {reasoning.model && <p><span className="text-muted-foreground">Model:</span> {reasoning.model}</p>}
                {reasoning.tokenMode && <p><span className="text-muted-foreground">Token mode:</span> {reasoning.tokenMode}</p>}
                {reasoning.intent && (
                  <p className="border-t border-border/30 pt-1 mt-1">
                    <span className="text-muted-foreground">Goal influence:</span>{" "}
                    <span className="text-foreground/80">{String(reasoning.intent)}</span>
                  </p>
                )}
              </div>
            )}

            {/* Override */}
            <div className="flex items-center gap-2">
              <Label className="text-[10px] text-muted-foreground shrink-0">Override:</Label>
              <select
                className="flex-1 h-7 text-xs rounded border border-border/50 bg-background px-2 text-foreground"
                value={bundleOverride == null ? "__auto__" : bundleOverride === "none" ? "__none__" : String(bundleOverride)}
                onChange={e => {
                  if (e.target.value === "__auto__") setBundleOverride(null);
                  else if (e.target.value === "__none__") setBundleOverride("none");
                  else setBundleOverride(Number(e.target.value));
                }}
              >
                <option value="__auto__">Auto (recommended)</option>
                <option value="__none__">No skills</option>
                {bundles.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Team members */}
          <div className="border border-border/40 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setTeamOpen(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/20 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                Add team members
                {teamOpen && memberNames.filter(Boolean).length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                    {memberNames.filter(Boolean).length}
                  </Badge>
                )}
              </span>
              {teamOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {teamOpen && (
              <div className="px-3 pb-3 space-y-2 bg-secondary/10">
                <p className="text-[10px] text-muted-foreground/70 pt-2">
                  Each member gets a private IDE with a unique password (up to 4).
                </p>
                {memberNames.map((name, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={name}
                      onChange={e => updateMember(i, e.target.value)}
                      placeholder={`Member ${i + 1} name`}
                      className="h-7 text-xs bg-background/50 border-border/50"
                      maxLength={24}
                    />
                    {memberNames.length > 1 && (
                      <button type="button" onClick={() => removeMember(i)} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {memberNames.length < 4 && (
                  <button type="button" onClick={addMember} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                    <Plus className="w-3 h-3" /> Add another
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLaunching}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={isLaunching} className="gap-2">
            {isLaunching
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Launching…</>
              : <><Play className="w-4 h-4" fill="currentColor" /> Launch Session</>
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
