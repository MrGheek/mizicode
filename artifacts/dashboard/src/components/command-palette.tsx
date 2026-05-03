import { useEffect, useState, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSessions,
  useGetActiveSession,
  useEnqueueRepoIndex,
  getGetRepoSummaryQueryKey,
  getGetRepoFingerprintQueryKey,
} from "@workspace/api-client-react";
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
} from "lucide-react";
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

  const { data: sessions } = useListSessions();
  const { data: activeSessionResp } = useGetActiveSession();
  const activeSession = activeSessionResp?.session ?? null;

  const enqueueRepoIndex = useEnqueueRepoIndex();

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isCommandPaletteShortcut(e)) {
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
    window.dispatchEvent(new CustomEvent("floatr:request-stop-session"));
  }, []);

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

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0 max-w-xl">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Search for commands and navigate FLOATR with your keyboard.
          </DialogDescription>
          <Command label="Command palette">
            <CommandInput placeholder="Type a command or search…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>

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
                  onSelect={() => runCommand(() => setLocation("/"))}
                  keywords={["new", "launch", "create", "session"]}
                >
                  <Plus /> New Session
                  <CommandShortcut>n</CommandShortcut>
                </CommandItem>
                {lastStoppedSession && (
                  <CommandItem
                    onSelect={() =>
                      runCommand(() =>
                        setLocation(`/sessions/${lastStoppedSession.id}?relaunch=1`),
                      )
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
