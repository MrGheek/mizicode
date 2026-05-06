import { useState, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import {
  useGetDashboardSummary,
  useGetActiveSession,
  useListProfiles,
  useCreateSession,
  useGetSchedulerConfig,
  useUpdateSchedulerConfig,
  useListSessions,
  useCloneSession,
  useGetClaimCleanupStats,
  getGetDashboardSummaryQueryKey,
  getGetActiveSessionQueryKey,
  getGetSchedulerConfigQueryKey,
  getCloneSessionQueryKey,
} from "@workspace/api-client-react";
import type { Session, ClaimCleanupStats } from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { RelaunchButton } from "@/components/relaunch-button";
import { X, History } from "lucide-react";
import type { GpuProfile, SchedulerConfig, UpdateSchedulerRequest } from "@workspace/api-client-react";
import type { LaunchOptions } from "@/components/launch-session-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, Clock, DollarSign, Server, Terminal, ArrowRight,
  Target, Trash2, Star, Network, Zap, Cpu, Calendar, Monitor,
} from "lucide-react";
import { getGetClaimCleanupStatsQueryKey } from "@workspace/api-client-react";
import { SwarmPill } from "@/components/swarm-activity-panel";
import { ProfileCard } from "@/components/profile-card";
import { NimLaunchSection } from "@/components/nim-launch-section";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { SchedulerConfigCard } from "@/components/scheduler-config-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

type DashTab = "fast" | "gpu" | "scheduler";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DashTab>("fast");
  const [launchingProfileId, setLaunchingProfileId] = useState<number | null>(null);
  const [isSavingScheduler, setIsSavingScheduler] = useState(false);
  const [dismissTick, setDismissTick] = useState(0);
  const { pinnedIds, togglePin } = usePinnedProfiles();

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: cleanupStats } = useGetClaimCleanupStats({ query: { queryKey: getGetClaimCleanupStatsQueryKey(), refetchInterval: 300000 } });
  const { data: activeSessionResp, isLoading: isLoadingSession } = useGetActiveSession({
    query: { refetchInterval: 10000, queryKey: getGetActiveSessionQueryKey() }
  });
  const { data: profiles, isLoading: isLoadingProfiles } = useListProfiles();
  const { data: allSessions } = useListSessions();
  const { data: schedulerConfig } = useGetSchedulerConfig({
    query: { queryKey: getGetSchedulerConfigQueryKey() }
  });

  const createSession = useCreateSession();
  const updateScheduler = useUpdateSchedulerConfig();

  const handleLaunch = (profileId: number, opts?: Omit<LaunchOptions, "profileId">) => {
    setLaunchingProfileId(profileId);
    createSession.mutate({
      data: {
        profileId,
        teamMembers: opts?.teamMembers ?? null,
        taskMode: opts?.taskMode ?? null,
        tokenMode: opts?.tokenMode ?? null,
        bundleId: opts?.bundleId ?? null,
        repoUrl: opts?.repoUrl ?? null,
        intentText: opts?.intentText ?? null,
        githubToken: opts?.githubToken ?? null,
      }
    }, {
      onSuccess: (session) => {
        toast({
          title: "Session Launched",
          description: "Provisioning GPU — model download will begin shortly (~30 min to ready).",
        });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setLocation(`/sessions/${session.id}`);
      },
      onError: (err: Error) => {
        toast({
          title: "Launch Failed",
          description: err?.message || "Failed to start session. Please try again.",
          variant: "destructive",
        });
        setLaunchingProfileId(null);
      }
    });
  };

  const handleSaveScheduler = async (updates: Partial<SchedulerConfig>) => {
    setIsSavingScheduler(true);
    return new Promise<void>((resolve, reject) => {
      updateScheduler.mutate({ data: updates as UpdateSchedulerRequest }, {
        onSuccess: () => {
          toast({ title: "Scheduler saved" });
          queryClient.invalidateQueries({ queryKey: getGetSchedulerConfigQueryKey() });
          setIsSavingScheduler(false);
          resolve();
        },
        onError: (err: Error) => {
          toast({
            title: "Save Failed",
            description: err?.message || "Failed to save scheduler config.",
            variant: "destructive",
          });
          setIsSavingScheduler(false);
          reject(err);
        }
      });
    });
  };

  const activeSession = activeSessionResp?.session;

  const continueCandidate = useMemo<Session | null>(() => {
    if (activeSession || !allSessions) return null;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const isDismissed = (id: number): boolean => {
      try { return localStorage.getItem(`mizi:continue-dismissed:${id}`) === "1"; } catch { return false; }
    };
    const candidate = allSessions
      .filter((s) => s.status === "stopped" && s.intentText)
      .filter((s) => {
        const ts = s.stoppedAt ? new Date(s.stoppedAt).getTime() : new Date(s.createdAt).getTime();
        return ts >= cutoff;
      })
      .filter((s) => !isDismissed(s.id))
      .sort((a, b) => {
        const ta = a.stoppedAt ? new Date(a.stoppedAt).getTime() : new Date(a.createdAt).getTime();
        const tb = b.stoppedAt ? new Date(b.stoppedAt).getTime() : new Date(b.createdAt).getTime();
        return tb - ta;
      })[0];
    return candidate ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, allSessions, dismissTick]);

  const dismissContinue = (sessionId: number) => {
    try { localStorage.setItem(`mizi:continue-dismissed:${sessionId}`, "1"); } catch { /* ignore */ }
    setDismissTick((n) => n + 1);
  };

  const recentSessions = useMemo(() => {
    if (!allSessions) return [];
    return [...allSessions]
      .filter((s) => s.status === "stopped")
      .sort((a, b) => {
        const ta = a.stoppedAt ? new Date(a.stoppedAt).getTime() : new Date(a.createdAt).getTime();
        const tb = b.stoppedAt ? new Date(b.stoppedAt).getTime() : new Date(b.createdAt).getTime();
        return tb - ta;
      })
      .slice(0, 4);
  }, [allSessions]);

  const nim = activeSession as typeof activeSession & { provider?: string; nimModelId?: string; nimProvider?: string } | undefined;
  const isNimSession = nim?.provider === "nim";
  const sessionLabel = activeSession
    ? (isNimSession ? (nim?.nimModelId ?? activeSession.profileName) : activeSession.profileName)
    : null;

  const tabs: Array<{ id: DashTab; icon: React.ElementType; label: string; sub: string; color: string }> = [
    { id: "fast",      icon: Zap,      label: "Fast Launch",  sub: "~2 min",  color: "emerald" },
    { id: "gpu",       icon: Monitor,  label: "GPU Sessions", sub: "~25 min", color: "cyan"    },
    { id: "scheduler", icon: Calendar, label: "Scheduler",    sub: "",        color: "slate"   },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0a0a0f] text-slate-300">

      {/* ── TOP STATUS BAR ─────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-[#0d0d14] border-b border-white/5 px-6 py-3 flex items-center gap-6">

        {/* Active session indicator */}
        <div className="flex items-center gap-2.5 min-w-0">
          {isLoadingSession ? (
            <Skeleton className="h-4 w-32 bg-white/5" />
          ) : activeSession ? (
            <>
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
              </span>
              <div className="min-w-0">
                <span className="text-sm font-medium text-white truncate">{sessionLabel}</span>
                {isNimSession && nim?.nimProvider && (
                  <span className="ml-2 text-[10px] text-emerald-400 font-mono">via {nim.nimProvider}</span>
                )}
              </div>
              <SessionStatusBadge status={activeSession.status} />
              {activeSession.teamMembers && activeSession.teamMembers.length > 0 && (
                <TeamSessionBadge members={activeSession.teamMembers} />
              )}
              {activeSession.costPerHour != null && (
                <span className="text-[11px] font-mono text-slate-500 shrink-0">
                  ${activeSession.costPerHour.toFixed(2)}/hr
                </span>
              )}
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-slate-700 shrink-0" />
              <span className="text-xs text-slate-500">No active session</span>
            </>
          )}
        </div>

        {/* View Cockpit */}
        {activeSession && (
          <button
            onClick={() => setLocation(`/sessions/${activeSession.id}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-slate-300 transition-colors shrink-0"
          >
            <Terminal className="w-3.5 h-3.5" />
            View Cockpit
          </button>
        )}
        {activeSession && <SwarmPill sessionId={activeSession.id} isReady={activeSession.status === "ready"} />}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-center gap-6 text-xs font-mono text-slate-500 shrink-0">
          {isLoadingSummary ? (
            <Skeleton className="h-3 w-48 bg-white/5" />
          ) : (
            <>
              <span><span className="text-slate-300">{summary?.activeSessions ?? 0}</span> active</span>
              <span><span className="text-slate-300">{summary?.totalSessions ?? 0}</span> sessions</span>
              <span><span className="text-slate-300">{(summary?.totalHours ?? 0).toFixed(1)}h</span> compute</span>
              <span><span className="text-slate-300">${(summary?.totalCost ?? 0).toFixed(2)}</span> spent</span>
            </>
          )}
        </div>
      </div>

      {/* ── TAB NAV ───────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-white/5 px-6 flex items-end gap-0">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          const activeColor =
            tab.color === "emerald" ? "border-emerald-500 text-emerald-300"
            : tab.color === "cyan"  ? "border-cyan-500 text-cyan-300"
            :                         "border-slate-400 text-slate-200";
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${
                active ? activeColor : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.sub && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                  active && tab.color === "emerald"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : active && tab.color === "cyan"
                    ? "bg-cyan-500/15 text-cyan-400"
                    : "bg-white/5 text-slate-500"
                }`}>
                  {tab.sub}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── TAB CONTENT ──────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto relative">

        {/* Background glow effects */}
        <div className="fixed top-[-200px] right-[-200px] w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[120px] pointer-events-none z-0" />
        <div className="fixed bottom-[-200px] right-[200px] w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-[100px] pointer-events-none z-0" />

        <div className="relative z-10 p-8 max-w-5xl">

          {/* FAST LAUNCH TAB */}
          {activeTab === "fast" && (
            <div className="space-y-8">
              {continueCandidate && (
                <ContinueCard session={continueCandidate} onDismiss={() => dismissContinue(continueCandidate.id)} />
              )}

              <section>
                <div className="flex items-center gap-3 mb-1">
                  <Zap className="w-5 h-5 text-emerald-400" />
                  <h2 className="text-xl font-bold text-white tracking-tight">Hosted Inference</h2>
                </div>
                <p className="text-emerald-400/70 text-xs mb-6 flex items-center gap-2">
                  <span className="w-1 h-1 bg-emerald-500 rounded-full" />
                  Start in ~2 minutes — no GPU rental needed
                </p>
                <NimLaunchSection />
              </section>

              {recentSessions.length > 0 && (
                <>
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                  <section>
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-4">Recent Sessions</p>
                    <div className="flex flex-col gap-3">
                      {recentSessions.map((s) => {
                        const ref = s.stoppedAt ? new Date(s.stoppedAt) : new Date(s.createdAt);
                        const ago = formatDistanceToNow(ref, { addSuffix: true });
                        const cost = s.totalCost ? `$${s.totalCost.toFixed(2)}` : "—";
                        return (
                          <button
                            key={s.id}
                            onClick={() => setLocation(`/sessions/${s.id}`)}
                            className="flex items-center justify-between text-sm group w-full text-left"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-1.5 h-1.5 rounded-full bg-slate-600 group-hover:bg-slate-400 transition-colors shrink-0" />
                              <span className="text-slate-400 group-hover:text-slate-200 transition-colors truncate text-xs">
                                {s.profileName}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500 shrink-0 ml-2">
                              <span>{ago.replace(" ago", "")}</span>
                              <span>{cost}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}
            </div>
          )}

          {/* GPU SESSIONS TAB */}
          {activeTab === "gpu" && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <Cpu className="w-5 h-5 text-cyan-400" />
                  <h2 className="text-xl font-bold text-white tracking-tight">GPU Sessions</h2>
                </div>
                <p className="text-slate-400 text-xs mb-6 flex items-center gap-2">
                  <span className="w-1 h-1 bg-slate-500 rounded-full" />
                  Full dedicated instances — boot time 25–35 min
                </p>
              </div>
              <QuickLaunchProfiles
                profiles={profiles}
                isLoading={isLoadingProfiles}
                launchingProfileId={launchingProfileId}
                onLaunch={handleLaunch}
                pinnedIds={pinnedIds}
                onTogglePin={togglePin}
              />
              {cleanupStats && (
                <>
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                  <ClaimCleanupCard stats={cleanupStats} />
                </>
              )}
            </div>
          )}

          {/* SCHEDULER TAB */}
          {activeTab === "scheduler" && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <Calendar className="w-5 h-5 text-slate-400" />
                  <h2 className="text-xl font-bold text-white tracking-tight">Session Scheduler</h2>
                </div>
                <p className="text-slate-400 text-xs mb-6 flex items-center gap-2">
                  <span className="w-1 h-1 bg-slate-500 rounded-full" />
                  Auto-launch a session before your workday starts
                </p>
              </div>
              {schedulerConfig ? (
                <SchedulerConfigCard
                  config={schedulerConfig}
                  profiles={profiles || []}
                  onSave={handleSaveScheduler}
                  isSaving={isSavingScheduler}
                />
              ) : (
                <Skeleton className="h-48 w-full bg-white/5" />
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

interface ContinueCardProps { session: Session; onDismiss: () => void; }

function projectNameFromRepoUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const sshMatch = trimmed.match(/[:/]([^/:]+\/[^/:]+)$/);
  if (sshMatch) return sshMatch[1];
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (parts.length === 1) return parts[0];
  } catch { /* fall through */ }
  return trimmed.split("/").pop() || null;
}

function ContinueCard({ session, onDismiss }: ContinueCardProps) {
  const stoppedRef = session.stoppedAt ? new Date(session.stoppedAt) : new Date(session.createdAt);
  const ago = formatDistanceToNow(stoppedRef, { addSuffix: true });
  const cost = session.totalCost?.toFixed(2) ?? "0.00";
  const intent = session.intentText ?? "";
  const { data: cloneData } = useCloneSession(session.id, {
    query: { queryKey: getCloneSessionQueryKey(session.id), staleTime: 60_000 },
  });
  const projectName = projectNameFromRepoUrl(cloneData?.repoUrl);
  return (
    <div className="bg-white/[0.02] border border-white/10 rounded-xl p-4 relative flex items-center gap-4 flex-wrap">
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss continue-where-you-left-off card"
        className="absolute top-3 right-3 text-slate-500 hover:text-slate-300 transition-colors"
        data-testid="button-dismiss-continue"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className="rounded-full bg-primary/15 p-2 mt-0.5 shrink-0">
          <History className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-white">Continue where you left off</h3>
            {projectName && (
              <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{projectName}</span>
            )}
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {session.profileName} · {ago}
            </span>
          </div>
          <p className="text-xs text-slate-300 mt-1 flex items-start gap-1.5">
            <Target className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <span className="line-clamp-2">{intent}</span>
          </p>
          <p className="text-[11px] text-slate-500 font-mono mt-1">
            Last run cost ${cost} · Session #{session.id}
          </p>
        </div>
      </div>
      <RelaunchButton sessionId={session.id} variant="prominent" label="Re-launch" />
    </div>
  );
}

const PINNED_STORAGE_KEY = "mizi:pinned-profiles";

function usePinnedProfiles() {
  const [pinnedIds, setPinnedIds] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch { return []; }
  });

  const togglePin = useCallback((profileId: number) => {
    setPinnedIds((prev) => {
      const next = prev.includes(profileId)
        ? prev.filter((id) => id !== profileId)
        : [...prev, profileId];
      try { localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { pinnedIds, togglePin };
}

interface QuickLaunchProfilesProps {
  profiles: GpuProfile[] | undefined;
  isLoading: boolean;
  launchingProfileId: number | null;
  onLaunch: (profileId: number, opts?: Omit<LaunchOptions, "profileId">) => void;
  pinnedIds: number[];
  onTogglePin: (profileId: number) => void;
}

const SWARM_CONSTRAINED_CAP = 8;
function isSwarmConstrained(profile: GpuProfile): boolean {
  const cap = profile.swarmWorkerCap ?? 0;
  return cap > 0 && cap <= SWARM_CONSTRAINED_CAP;
}

function QuickLaunchProfiles({ profiles, isLoading, launchingProfileId, onLaunch, pinnedIds, onTogglePin }: QuickLaunchProfilesProps) {
  const [swarmOnly, setSwarmOnly] = useState(false);

  const filteredProfiles = useMemo(() => {
    if (!profiles) return undefined;
    const base = swarmOnly ? profiles.filter((p) => (p.swarmWorkerCap ?? 0) > 8) : profiles;
    return [...base].sort((a, b) => {
      const ac = isSwarmConstrained(a) ? 1 : 0;
      const bc = isSwarmConstrained(b) ? 1 : 0;
      return ac - bc;
    });
  }, [profiles, swarmOnly]);

  const modelGroups = useMemo(() => {
    if (!filteredProfiles) return [];
    const groupMap = new Map<string, GpuProfile[]>();
    for (const profile of filteredProfiles) {
      const model = profile.modelDisplayName;
      if (!groupMap.has(model)) groupMap.set(model, []);
      groupMap.get(model)!.push(profile);
    }
    for (const group of groupMap.values()) {
      group.sort((a, b) => {
        const ac = isSwarmConstrained(a) ? 1 : 0;
        const bc = isSwarmConstrained(b) ? 1 : 0;
        if (ac !== bc) return ac - bc;
        return a.estimatedCostMin - b.estimatedCostMin;
      });
    }
    const groups = Array.from(groupMap.entries()).map(([model, items]) => ({ model, items }));
    groups.sort((a, b) => {
      const aAllConstrained = a.items.every(isSwarmConstrained) ? 1 : 0;
      const bAllConstrained = b.items.every(isSwarmConstrained) ? 1 : 0;
      return aAllConstrained - bAllConstrained;
    });
    return groups;
  }, [filteredProfiles]);

  const isGrouped = modelGroups.length >= 2;

  const pinnedProfiles = useMemo(() => {
    if (!profiles) return [];
    return pinnedIds
      .map((id) => profiles.find((p) => p.id === id))
      .filter((p): p is GpuProfile => p !== undefined);
  }, [profiles, pinnedIds]);

  const hasFavourites = pinnedProfiles.length > 0;

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          type="button"
          onClick={() => setSwarmOnly((v) => !v)}
          data-testid="filter-swarm-ready"
          aria-pressed={swarmOnly}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
            swarmOnly
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-transparent text-slate-400 border-white/10 hover:border-white/20 hover:text-slate-200"
          }`}
        >
          <Network className="w-3.5 h-3.5" />
          Swarm-ready only
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full bg-white/5" />
          ))}
        </div>
      ) : !filteredProfiles?.length ? (
        <div className="p-8 text-center border border-dashed rounded-xl border-white/10 text-slate-500 text-sm">
          {swarmOnly ? "No swarm-ready profiles available." : "No GPU profiles configured."}
        </div>
      ) : (
        <div className="space-y-8">
          {hasFavourites && (
            <div>
              <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-yellow-500/20">
                <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-200">
                  <Star className="w-4 h-4 text-yellow-400" fill="currentColor" />
                  Favourites
                </h3>
                <span className="text-xs text-slate-500">Your pinned profiles</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {pinnedProfiles.map((profile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    onLaunch={onLaunch}
                    isLaunching={launchingProfileId === profile.id}
                    isDefaultLaunch={false}
                    isPinned={true}
                    onTogglePin={() => onTogglePin(profile.id)}
                    pinTestIdSuffix="fav"
                  />
                ))}
              </div>
            </div>
          )}

          {isGrouped ? (
            modelGroups.map(({ model, items }, groupIdx) => (
              <div key={model}>
                <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/5">
                  <h3 className="text-sm font-semibold text-slate-200">{model}</h3>
                  <span className="text-xs text-slate-500">{items[0]?.benchmarkCallout ?? "Open-weight model"}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {items.map((profile, idx) => (
                    <ProfileCard
                      key={profile.id}
                      profile={profile}
                      onLaunch={onLaunch}
                      isLaunching={launchingProfileId === profile.id}
                      isDefaultLaunch={!hasFavourites && groupIdx === 0 && idx === 0}
                      isPinned={pinnedIds.includes(profile.id)}
                      onTogglePin={() => onTogglePin(profile.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProfiles.map((profile, idx) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onLaunch={onLaunch}
                  isLaunching={launchingProfileId === profile.id}
                  isDefaultLaunch={!hasFavourites && idx === 0}
                  isPinned={pinnedIds.includes(profile.id)}
                  onTogglePin={() => onTogglePin(profile.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ClaimCleanupCard({ stats }: { stats: ClaimCleanupStats }) {
  const lastRun = stats.lastPurgedAt
    ? formatDistanceToNow(new Date(stats.lastPurgedAt), { addSuffix: true })
    : null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <Trash2 className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-400">Claim Cleanup Health</h3>
      </div>
      <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-4">
          {[
            { label: "Total Purge Runs", value: stats.totalRuns },
            { label: "Total Rows Deleted", value: stats.totalRowsDeleted.toLocaleString() },
            { label: "Last Run", value: lastRun ?? "—", mono: false },
            { label: "Last Rows Deleted", value: stats.lastRowsDeleted ?? "—" },
          ].map(({ label, value, mono = true }) => (
            <div key={label}>
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{label}</p>
              <p className={`text-lg font-semibold text-slate-200 ${mono ? "font-mono" : "text-sm"}`}>{value}</p>
            </div>
          ))}
        </div>
        {stats.recentRuns.length > 0 && (
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-2">Recent Runs</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-slate-500">
                    <th className="text-left pb-1 pr-4 font-medium">Time</th>
                    <th className="text-right pb-1 pr-4 font-medium">Rows Deleted</th>
                    <th className="text-right pb-1 font-medium">Retention (days)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentRuns.slice(0, 10).map((run) => (
                    <tr key={run.id} className="border-b border-white/5 last:border-0">
                      <td className="py-1.5 pr-4 font-mono text-slate-500">
                        {formatDistanceToNow(new Date(run.purgedAt), { addSuffix: true })}
                      </td>
                      <td className={`py-1.5 pr-4 text-right font-mono font-semibold ${run.rowsDeleted > 0 ? "text-slate-200" : "text-slate-500"}`}>
                        {run.rowsDeleted}
                      </td>
                      <td className="py-1.5 text-right font-mono text-slate-500">{run.retentionDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
