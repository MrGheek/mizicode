import { useEffect, useState, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import {
  useListSessions,
  useGetActiveSession,
  useEnqueueRepoIndex,
  useCloneSession,
  useListProfiles,
  useCreateSession,
  cloneSession,
  resolvePaletteIntent,
  getGetRepoSummaryQueryKey,
  getGetRepoFingerprintQueryKey,
  getCloneSessionQueryKey,
  getGetActiveSessionQueryKey,
  getGetDashboardSummaryQueryKey,
  getListProfilesQueryKey,
} from "@workspace/api-client-react";
import type { CloneSessionResponse, PaletteIntentResponse } from "@workspace/api-client-react";
import { LaunchSessionDialog, type LaunchOptions, type LaunchPrefill } from "@/components/launch-session-dialog";
import { IS_LOCAL_BUILD } from "@/lib/distribution";
import {
  LayoutDashboard,
  Terminal,
  Wand2,
  Brain,
  Calendar,
  Plus,
  RotateCcw,
  StopCircle,
  RefreshCw,
  Copy,
  ExternalLink,
  ArrowRight,
  Keyboard,
  Layers,
  Palette,
  Sparkles,
  Loader2,
} from "lucide-react";
import { FaGithub as Github } from "react-icons/fa";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { isCommandPaletteShortcut, isTypingTarget } from "@/lib/shortcuts";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

/**
 * Global command palette. Mounted in AppLayout so it's available app-wide.
 * Listens for Cmd/Ctrl+K to open the palette, and "?" to open a help overlay.
 *
 * The palette is context-aware: when on a session detail page, session-specific
 * commands (Stop, Re-index, Copy SSH, etc.) are added.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Track the current search query so we can surface "Ask AI" when non-empty.
  const [query, setQuery] = useState("");
  // Track whether the AI is resolving an intent.
  const [aiPending, setAiPending] = useState(false);

  const { data: sessions } = useListSessions();
  const { data: activeSessionResp } = useGetActiveSession();
  const activeSession = activeSessionResp?.session ?? null;

  const enqueueRepoIndex = useEnqueueRepoIndex();
  const { data: profiles } = useListProfiles({ query: { enabled: !IS_LOCAL_BUILD, queryKey: getListProfilesQueryKey() } });
  const createSession = useCreateSession();
  const cloneMutation = useMutation<CloneSessionResponse, Error, number>({
    mutationFn: (id: number) => cloneSession(id),
  });

  // Re-launch flow state — mirrors RelaunchButton so the palette runs the
  // same clone → prefill → LaunchSessionDialog → createSession path.
  const [relaunchPrefill, setRelaunchPrefill] = useState<LaunchPrefill | null>(null);
  const [relaunchProfileId, setRelaunchProfileId] = useState<number | null>(null);
  const [isRelaunching, setIsRelaunching] = useState(false);
  const relaunchProfile =
    relaunchProfileId != null ? profiles?.find((p) => p.id === relaunchProfileId) ?? null : null;

  // Detect "on a session detail page" — wouter passes routed location like
  // "/sessions/123". Extract the id if present.
  const sessionDetailId = useMemo<number | null>(() => {
    const match = location.match(/^\/sessions\/(\d+)/);
    return match ? Number(match[1]) : null;
  }, [location]);

  const currentSession = useMemo(() => {
    if (!sessionDetailId || !sessions) return null;
    return sessions.find((s) => s.id === sessionDetailId) ?? null;
  }, [sessionDetailId, sessions]);

  // Global hotkey listener: Cmd/Ctrl+K toggles palette, "?" opens help overlay.
  // Both are suppressed while typing in inputs/textareas/contenteditable so
  // they never steal keystrokes from forms (the palette's own input is allowed
  // to close itself via Escape, handled by Radix Dialog).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isCommandPaletteShortcut(e)) {
        // Allow Cmd/Ctrl+K only when not typing into the main app's inputs.
        // The palette's own input is fine — when the palette is already open,
        // we always allow toggling it shut.
        if (!open && isTypingTarget(e)) return;
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // "?" opens help overlay — but not while typing.
      if (e.key === "?" && !isTypingTarget(e) && !open) {
        // Avoid stealing "?" when help is already open (Escape closes it).
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const runCommand = useCallback((fn: () => void) => {
    setOpen(false);
    // Defer to allow the dialog to start unmounting before navigation/mutations.
    setTimeout(fn, 0);
  }, []);

  const handleReindex = useCallback(
    (sessionId: number) => {
      enqueueRepoIndex.mutate(
        { sessionId, data: {} },
        {
          onSuccess: () => {
            toast({
              title: "Re-index triggered",
              description: "Indexing job enqueued — this may take a few minutes.",
            });
            queryClient.invalidateQueries({ queryKey: getGetRepoSummaryQueryKey(sessionId) });
            queryClient.invalidateQueries({ queryKey: getGetRepoFingerprintQueryKey(sessionId) });
          },
          onError: () => toast({ title: "Failed to trigger re-index", variant: "destructive" }),
        },
      );
    },
    [enqueueRepoIndex, queryClient, toast],
  );

  // Stop is delegated to the session detail page so the existing feedback
  // dialog (and its routing-stats bytesAvoided telemetry) is reused. This
  // keeps the palette and the "s" cockpit shortcut behaviourally identical.
  const handleStopSession = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mizi:request-stop-session"));
  }, []);

  const handleRelaunch = useCallback(
    (sourceSessionId: number) => {
      cloneMutation.mutate(sourceSessionId, {
        onSuccess: (clone) => {
          const profilesLoaded = Array.isArray(profiles);
          const profileMissing =
            profilesLoaded && !profiles!.some((p) => p.id === clone.profileId);
          if (profileMissing) {
            toast({
              title: "Profile no longer available",
              description:
                "The GPU profile from the source session can't be found. Pick a profile from the dashboard instead.",
              variant: "destructive",
            });
            return;
          }
          setRelaunchProfileId(clone.profileId);
          setRelaunchPrefill({
            taskMode: clone.taskMode,
            tokenMode: clone.tokenMode,
            bundleId: clone.bundleId,
            repoUrl: clone.repoUrl,
            intentText: clone.intentText,
            teamMemberNames: clone.teamMemberNames,
            sourceSessionId: clone.sessionId,
          });
        },
        onError: (err) => {
          toast({
            title: "Could not load session",
            description: err?.message || "Failed to fetch the previous session details.",
            variant: "destructive",
          });
        },
      });
    },
    [cloneMutation, profiles, toast],
  );

  const handleRelaunchConfirm = useCallback(
    (opts: LaunchOptions) => {
      setIsRelaunching(true);
      createSession.mutate(
        {
          data: {
            profileId: opts.profileId,
            teamMembers: opts.teamMembers ?? null,
            taskMode: opts.taskMode ?? null,
            tokenMode: opts.tokenMode ?? null,
            bundleId: opts.bundleId ?? null,
            repoUrl: opts.repoUrl ?? null,
            intentText: opts.intentText ?? null,
          },
        },
        {
          onSuccess: (session) => {
            const token = (session as typeof session & { ownerToken?: string | null }).ownerToken;
            if (token) sessionStorage.setItem(`nim-owner-token:${session.id}`, token);
            toast({
              title: "Session re-launched",
              description: "Pre-filled from your previous session.",
            });
            queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
            setIsRelaunching(false);
            setRelaunchPrefill(null);
            setRelaunchProfileId(null);
            setLocation(`/sessions/${session.id}`);
          },
          onError: (err) => {
            toast({
              title: "Re-launch failed",
              description: err?.message || "Failed to start a new session.",
              variant: "destructive",
            });
            setIsRelaunching(false);
          },
        },
      );
    },
    [createSession, queryClient, setLocation, toast],
  );

  // "New Session" — navigates to the dashboard and asks the first profile
  // card to open its launch dialog. Using a window event avoids lifting state
  // out of ProfileCard while still giving us a single, real launch flow.
  const handleNewSession = useCallback(() => {
    if (location !== "/") {
      setLocation("/");
      // Wait for the dashboard to mount its ProfileCards before signalling.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("mizi:open-launch-dialog"));
      }, 50);
    } else {
      window.dispatchEvent(new CustomEvent("mizi:open-launch-dialog"));
    }
  }, [location, setLocation]);

  // Recover the current session's repo URL from the clone snapshot — Session
  // doesn't carry repoUrl directly, but the clone endpoint exposes it. Used
  // for the "Open Repo in GitHub" command.
  const { data: cloneSnapshot } = useCloneSession(currentSession?.id ?? 0, {
    query: {
      queryKey: getCloneSessionQueryKey(currentSession?.id ?? 0),
      enabled: Boolean(currentSession?.id),
      staleTime: 60_000,
    },
  });
  const currentRepoUrl = cloneSnapshot?.repoUrl ?? null;
  const githubUrl = useMemo(() => {
    if (!currentRepoUrl) return null;
    const trimmed = currentRepoUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!trimmed) return null;
    // git@github.com:owner/repo → https://github.com/owner/repo
    const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return null;
  }, [currentRepoUrl]);

  const handleCopySsh = useCallback(
    (session: NonNullable<typeof currentSession>) => {
      const sshHost = session.sshHost;
      const sshPort = session.sshPort;
      if (!sshHost || !sshPort) {
        toast({
          title: "No SSH connection available",
          description: "This session does not have SSH details yet.",
          variant: "destructive",
        });
        return;
      }
      const cmd = `ssh -p ${sshPort} root@${sshHost}`;
      navigator.clipboard
        .writeText(cmd)
        .then(() => toast({ title: "SSH command copied", description: cmd }))
        .catch(() => toast({ title: "Copy failed", variant: "destructive" }));
    },
    [toast],
  );

  // Execute a resolved palette intent action returned by the LLM.
  const executeIntent = useCallback(
    (intent: PaletteIntentResponse) => {
      if (!intent.ok || !intent.action) {
        toast({
          title: "Could not understand command",
          description: intent.explanation,
          variant: "destructive",
        });
        return;
      }

      const sessionId = intent.payload?.sessionId ?? null;

      switch (intent.action) {
        case "navigate": {
          const route = intent.payload?.route;
          if (route) {
            setLocation(route);
            toast({ title: intent.explanation });
          }
          break;
        }
        case "stop-session": {
          // If the targeted session is already in view, dispatch directly.
          // Otherwise navigate to that session's page first so the page-level
          // stop handler (which owns the confirmation dialog) is mounted.
          if (sessionId != null && !location.startsWith(`/sessions/${sessionId}`)) {
            setLocation(`/sessions/${sessionId}`);
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("mizi:request-stop-session"));
            }, 300);
          } else {
            window.dispatchEvent(new CustomEvent("mizi:request-stop-session"));
          }
          toast({ title: intent.explanation });
          break;
        }
        case "reindex-session":
          if (sessionId != null) {
            handleReindex(sessionId);
          }
          break;
        case "new-session":
          handleNewSession();
          toast({ title: intent.explanation });
          break;
        case "relaunch-session":
          if (sessionId != null) {
            handleRelaunch(sessionId);
            toast({ title: intent.explanation });
          }
          break;
        case "copy-ssh": {
          const target = sessionId != null ? sessions?.find((s) => s.id === sessionId) : null;
          if (target) {
            handleCopySsh(target);
          } else {
            toast({
              title: "Session not found",
              description: "Could not locate session to copy SSH command.",
              variant: "destructive",
            });
          }
          break;
        }
        default:
          toast({
            title: "Unknown action",
            description: intent.explanation,
            variant: "destructive",
          });
      }
    },
    [handleCopySsh, handleNewSession, handleReindex, handleRelaunch, location, sessions, setLocation, toast],
  );

  // Most-recent stopped session (for "Re-launch last session").
  const lastStoppedSession = useMemo(() => {
    if (!sessions) return null;
    const stopped = sessions
      .filter((s) => s.status === "stopped")
      .sort((a, b) => {
        const ta = a.stoppedAt ? new Date(a.stoppedAt).getTime() : new Date(a.createdAt).getTime();
        const tb = b.stoppedAt ? new Date(b.stoppedAt).getTime() : new Date(b.createdAt).getTime();
        return tb - ta;
      });
    return stopped[0] ?? null;
  }, [sessions]);

  // Top sessions to show as quick-jump entries (limit to keep palette compact).
  const sessionsForJump = useMemo(() => {
    if (!sessions) return [];
    // Prefer running first, then most recent stopped, capped at 8.
    const sorted = [...sessions].sort((a, b) => {
      const aActive = a.status === "ready" || a.status === "starting" ? 0 : 1;
      const bActive = b.status === "ready" || b.status === "starting" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return sorted.slice(0, 8);
  }, [sessions]);

  // Send the current query to the LLM palette-intent endpoint and execute the result.
  const handleAskAi = useCallback(async () => {
    if (!query.trim() || aiPending) return;
    setAiPending(true);
    setOpen(false);
    try {
      const intent = await resolvePaletteIntent({
        query: query.trim(),
        context: {
          route: location,
          activeSessionId: activeSession?.id ?? null,
          activeSessionStatus: activeSession?.status ?? null,
          recentSessionIds: sessionsForJump.map((s) => s.id),
        },
      });
      setTimeout(() => executeIntent(intent), 0);
    } catch {
      toast({
        title: "AI command failed",
        description: "Could not reach the AI service. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAiPending(false);
    }
  }, [activeSession, aiPending, executeIntent, location, query, sessionsForJump, toast]);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
        <DialogContent className="overflow-hidden p-0 max-w-xl">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Search for commands and navigate MIZI with your keyboard.
          </DialogDescription>
          <Command label="Command palette">
            <CommandInput
              placeholder="Type a command or ask AI…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {query.trim().length > 0 ? (
                  <CommandItem
                    value={`ask-ai-${query}`}
                    onSelect={() => { void handleAskAi(); }}
                    disabled={aiPending}
                    className="flex items-center gap-2 justify-center cursor-pointer"
                  >
                    {aiPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    <span className="text-sm text-primary">
                      {aiPending ? "Asking AI…" : `Ask AI: "${query.trim()}"`}
                    </span>
                  </CommandItem>
                ) : (
                  "No results found."
                )}
              </CommandEmpty>

              <CommandGroup heading="Navigation">
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/"))}
                  keywords={["dashboard", "home", "mission control"]}
                >
                  <LayoutDashboard /> Dashboard
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/sessions"))}
                  keywords={["sessions", "list", "history"]}
                >
                  <Terminal /> Sessions List
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/skills"))}
                  keywords={["skills", "library"]}
                >
                  <Wand2 /> Skills
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/memory"))}
                  keywords={["memory"]}
                >
                  <Brain /> Memory
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/templates"))}
                  keywords={["templates", "bundles"]}
                >
                  <Layers /> Templates
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/design-intelligence"))}
                  keywords={["design", "intelligence"]}
                >
                  <Palette /> Design Intelligence
                </CommandItem>
                <CommandItem
                  onSelect={() => runCommand(() => setLocation("/"))}
                  keywords={["scheduler", "schedule"]}
                >
                  <Calendar /> Scheduler (on Dashboard)
                </CommandItem>
              </CommandGroup>

              <CommandGroup heading="Sessions">
                <CommandItem
                  onSelect={() => runCommand(() => handleNewSession())}
                  keywords={["new", "launch", "create", "session"]}
                >
                  <Plus /> New Session
                  <CommandShortcut>n</CommandShortcut>
                </CommandItem>
                {lastStoppedSession && (
                  <CommandItem
                    onSelect={() =>
                      runCommand(() => handleRelaunch(lastStoppedSession.id))
                    }
                    keywords={["relaunch", "re-launch", "resume", "last"]}
                  >
                    <RotateCcw /> Re-launch last session
                    <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                      {lastStoppedSession.profileName}
                    </span>
                  </CommandItem>
                )}
                {activeSession && (
                  <CommandItem
                    onSelect={() =>
                      runCommand(() => setLocation(`/sessions/${activeSession.id}`))
                    }
                    keywords={["active", "current", "cockpit"]}
                  >
                    <ArrowRight /> Go to active session
                    <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                      #{activeSession.id} · {activeSession.profileName}
                    </span>
                  </CommandItem>
                )}
                {sessionsForJump.map((s) => {
                  const subtitle = s.intentText ?? s.profileName;
                  return (
                    <CommandItem
                      key={`session-${s.id}`}
                      value={`session-${s.id}-${s.profileName}-${s.intentText ?? ""}`}
                      onSelect={() => runCommand(() => setLocation(`/sessions/${s.id}`))}
                      keywords={[
                        `#${s.id}`,
                        s.profileName,
                        s.intentText ?? "",
                        s.status,
                      ]}
                    >
                      <Terminal />
                      <span className="flex flex-col items-start min-w-0 flex-1">
                        <span className="text-sm">
                          Go to session #{s.id}
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                            {s.status}
                          </span>
                        </span>
                        <span className="text-[11px] text-muted-foreground truncate max-w-full">
                          {subtitle}
                        </span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>

              {currentSession && (
                <CommandGroup heading="Actions (current session)">
                  <CommandItem
                    onSelect={() => runCommand(() => handleReindex(currentSession.id))}
                    keywords={["reindex", "re-index", "repo", "trigger"]}
                  >
                    <RefreshCw /> Trigger Re-index
                    <CommandShortcut>r</CommandShortcut>
                  </CommandItem>
                  {currentSession.status !== "stopped" && currentSession.status !== "error" && (
                    <CommandItem
                      onSelect={() => runCommand(() => handleStopSession())}
                      keywords={["stop", "destroy", "kill"]}
                    >
                      <StopCircle /> Stop Session
                      <CommandShortcut>s</CommandShortcut>
                    </CommandItem>
                  )}
                  <CommandItem
                    onSelect={() => runCommand(() => handleCopySsh(currentSession))}
                    keywords={["ssh", "copy", "shell"]}
                  >
                    <Copy /> Copy SSH Command
                  </CommandItem>
                  {currentSession.boltDiyUrl && (
                    <CommandItem
                      onSelect={() =>
                        runCommand(() =>
                          window.open(currentSession.boltDiyUrl ?? "", "_blank", "noopener"),
                        )
                      }
                      keywords={["ide", "editor", "bolt"]}
                    >
                      <ExternalLink /> Open Coding Environment
                    </CommandItem>
                  )}
                  {githubUrl && (
                    <CommandItem
                      onSelect={() =>
                        runCommand(() => window.open(githubUrl, "_blank", "noopener"))
                      }
                      keywords={["github", "repo", "repository", "open"]}
                    >
                      <Github /> Open Repo in GitHub
                    </CommandItem>
                  )}
                </CommandGroup>
              )}

              <CommandGroup heading="Help">
                <CommandItem
                  onSelect={() => runCommand(() => setHelpOpen(true))}
                  keywords={["help", "shortcuts", "keyboard"]}
                >
                  <Keyboard /> Show Keyboard Shortcuts
                  <CommandShortcut>?</CommandShortcut>
                </CommandItem>
              </CommandGroup>

            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} location={location} />

      {relaunchPrefill && relaunchProfile && (
        <LaunchSessionDialog
          profile={relaunchProfile}
          prefill={relaunchPrefill}
          onConfirm={handleRelaunchConfirm}
          onClose={() => {
            if (isRelaunching) return;
            setRelaunchPrefill(null);
            setRelaunchProfileId(null);
          }}
          isLaunching={isRelaunching}
        />
      )}
    </>
  );
}

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: string;
}

function KeyboardShortcutsHelp({ open, onOpenChange, location }: ShortcutsHelpProps) {
  // Page-context detection — same logic as CommandPalette.
  const onSessionDetail = /^\/sessions\/\d+/.test(location);
  const onSessionsList = location === "/sessions";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-primary" /> Keyboard Shortcuts
        </DialogTitle>
        <DialogDescription className="sr-only">
          List of keyboard shortcuts available on the current page.
        </DialogDescription>

        <div className="space-y-4 mt-2">
          <ShortcutSection
            title="Global"
            rows={[
              { keys: ["⌘ K", "Ctrl K"], label: "Open command palette" },
              { keys: ["?"], label: "Show this help" },
              { keys: ["Esc"], label: "Close any dialog" },
            ]}
          />

          {onSessionsList && (
            <ShortcutSection
              title="Sessions list"
              rows={[
                { keys: ["j"], label: "Move focus down" },
                { keys: ["k"], label: "Move focus up" },
                { keys: ["Enter"], label: "Open focused session" },
                { keys: ["n"], label: "New session" },
              ]}
            />
          )}

          {onSessionDetail && (
            <ShortcutSection
              title="Session cockpit"
              rows={[
                { keys: ["1"], label: "Overview tab" },
                { keys: ["2"], label: "Memory tab" },
                { keys: ["3"], label: "Smart Skills tab" },
                { keys: ["4"], label: "Repo Intelligence tab" },
                { keys: ["5"], label: "Coordination tab" },
                { keys: ["6"], label: "Swarm tab" },
                { keys: ["r"], label: "Trigger repo re-index" },
                { keys: ["s"], label: "Stop session" },
              ]}
            />
          )}
        </div>

        <p className="text-[10px] text-muted-foreground mt-4 pt-3 border-t border-border/40">
          Shortcuts are disabled while typing in a text field.
        </p>
      </DialogContent>
    </Dialog>
  );
}

interface ShortcutRow {
  keys: string[];
  label: string;
}

function ShortcutSection({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-foreground/90">{row.label}</span>
            <span className="flex items-center gap-1">
              {row.keys.map((k, j) => (
                <kbd
                  key={j}
                  className="px-1.5 py-0.5 rounded border border-border/60 bg-secondary/40 text-[11px] font-mono text-foreground/90 min-w-[24px] text-center"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-export the help dialog so pages can open it directly if needed.
export { KeyboardShortcutsHelp };

// (The context value type is defined for future use if we want to expose
// imperative open() to other components — kept intentionally unused for now.)
export type { CommandPaletteContextValue };
