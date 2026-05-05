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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity, Clock, DollarSign, Server, Terminal, Play, ArrowRight,
  Target, Trash2, Star, Network, Zap, Cpu, Calendar,
} from "lucide-react";
import { getGetClaimCleanupStatsQueryKey } from "@workspace/api-client-react";
import { SwarmPill } from "@/components/swarm-activity-panel";
import { ProfileCard } from "@/components/profile-card";
import { NimLaunchSection } from "@/components/nim-launch-section";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { SchedulerConfigCard } from "@/components/scheduler-config-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
      try { return localStorage.getItem(`floatr:continue-dismissed:${id}`) === "1"; } catch { return false; }
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
    try { localStorage.setItem(`floatr:continue-dismissed:${sessionId}`, "1"); } catch { /* ignore */ }
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

  const nextSchedule = useMemo(() => {
    if (!schedulerConfig?.enabled) return null;
    const days = schedulerConfig.daysOfWeek;
    const time = schedulerConfig.launchTime;
    if (!time) return null;
    const dayLabel = days.length > 0
      ? days[0].charAt(0).toUpperCase() + days[0].slice(1, 3)
      : null;
    return dayLabel ? `${dayLabel} ${time}` : time;
  }, [schedulerConfig]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#0a0a0f] text-slate-300">

      {/* ── LEFT DASHBOARD SIDEBAR ──────────────────────────────── */}
      <div className="w-[280px] flex-shrink-0 border-r border-white/5 bg-[#0d0d14] flex flex-col h-full overflow-y-auto">
        <div className="p-5 flex flex-col gap-5">

          {/* Active Session */}
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Active Session</p>
            {isLoadingSession ? (
              <div className="bg-white/[0.02] border border-white/10 rounded-xl p-4">
                <Skeleton className="h-4 w-24 mb-2 bg-white/5" />
                <Skeleton className="h-3 w-32 bg-white/5" />
              </div>
            ) : activeSession ? (
              <div className="bg-white/[0.02] border border-white/10 rounded-xl p-4 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50" />
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
                    </span>
                    <span className="text-[10px] text-cyan-400 font-mono font-semibold tracking-wider">ONLINE</span>
                  </div>
                  <SessionStatusBadge status={activeSession.status} />
                </div>
                <div className="font-semibold text-white text-sm mb-0.5 truncate">{activeSession.profileName}</div>
                <div className="text-xs text-slate-500 font-mono mb-1">
                  {activeSession.gpuName} · ${activeSession.costPerHour?.toFixed(2) ?? "0.00"}/hr
                </div>
                {activeSession.teamMembers && activeSession.teamMembers.length > 0 && (
                  <div className="mb-2"><TeamSessionBadge members={activeSession.teamMembers} /></div>
                )}
                <SwarmPill sessionId={activeSession.id} isReady={activeSession.status === "ready"} />
                <button
                  onClick={() => setLocation(`/sessions/${activeSession.id}`)}
                  className="mt-3 w-full py-2 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 rounded-lg text-xs font-medium text-white flex items-center justify-center gap-2"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  View Cockpit
                </button>
              </div>
            ) : (
              <div className="bg-white/[0.02] border border-dashed border-white/10 rounded-xl p-4 text-center">
                <Terminal className="w-6 h-6 mx-auto mb-1.5 text-slate-600" />
                <p className="text-xs text-slate-500">No active session</p>
              </div>
            )}
          </div>

          {/* Stats grid */}
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Overview</p>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { icon: Activity, label: "Active", value: isLoadingSummary ? "…" : String(summary?.activeSessions ?? 0) },
                { icon: Server, label: "Total", value: isLoadingSummary ? "…" : String(summary?.totalSessions ?? 0) },
                { icon: Clock, label: "Hours", value: isLoadingSummary ? "…" : `${(summary?.totalHours ?? 0).toFixed(1)}h` },
                { icon: DollarSign, label: "Spend", value: isLoadingSummary ? "…" : `$${(summary?.totalCost ?? 0).toFixed(2)}` },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-slate-500 mb-1">
                    <Icon className="w-3.5 h-3.5" />
                    <span className="text-[11px]">{label}</span>
                  </div>
                  <div className="text-base font-mono font-semibold text-white">{value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="h-px w-full bg-white/5" />

          {/* Scheduler compact */}
          {schedulerConfig && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium text-slate-300">Scheduler</span>
              </div>
              <div className="flex items-center gap-2">
                {nextSchedule && (
                  <span className="text-[10px] bg-white/8 border border-white/10 px-2 py-0.5 rounded font-mono text-slate-400 truncate max-w-[100px]">
                    {nextSchedule}
                  </span>
                )}
                <div className={`w-8 h-4 rounded-full relative border transition-colors ${
                  schedulerConfig.enabled
                    ? "bg-cyan-500/20 border-cyan-500/50"
                    : "bg-white/5 border-white/10"
                }`}>
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                    schedulerConfig.enabled
                      ? "right-0.5 bg-cyan-400"
                      : "left-0.5 bg-slate-600"
                  }`} />
                </div>
              </div>
            </div>
          )}

          <div className="h-px w-full bg-white/5" />

          {/* Recent sessions */}
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Sessions</p>
            {recentSessions.length === 0 ? (
              <p className="text-xs text-slate-600 italic">No past sessions yet</p>
            ) : (
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
                        <span className="hidden sm:inline">{ago.replace(" ago", "")}</span>
                        <span>{cost}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── RIGHT MAIN AREA ─────────────────────────────────────── */}
      <div className="flex-1 h-full overflow-y-auto relative">

        {/* Background glow effects */}
        <div className="fixed top-[-200px] right-[-200px] w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[120px] pointer-events-none z-0" />
        <div className="fixed bottom-[-200px] right-[200px] w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-[100px] pointer-events-none z-0" />

        <div className="relative z-10 p-8 space-y-10 max-w-5xl">

          {/* Continue card */}
          {continueCandidate && (
            <ContinueCard session={continueCandidate} onDismiss={() => dismissContinue(continueCandidate.id)} />
          )}

          {/* ── HOSTED INFERENCE ── */}
          <section>
            <div className="flex items-center gap-3 mb-1">
              <Zap className="w-5 h-5 text-emerald-400" />
              <h1 className="text-xl font-bold text-white tracking-tight">Hosted Inference</h1>
            </div>
            <p className="text-emerald-400/70 text-xs mb-6 flex items-center gap-2">
              <span className="w-1 h-1 bg-emerald-500 rounded-full" />
              Start in ~2 minutes — no GPU rental needed
            </p>
            <NimLaunchSection />
          </section>

          <div className="h-px w-full bg-gradient-to-r from-transparent via-white/5 to-transparent" />

          {/* ── GPU SESSIONS ── */}
          <section>
            <div className="flex items-center gap-3 mb-1">
              <Cpu className="w-5 h-5 text-cyan-400" />
              <h2 className="text-xl font-bold text-white tracking-tight">GPU Sessions</h2>
            </div>
            <p className="text-slate-400 text-xs mb-6 flex items-center gap-2">
              <span className="w-1 h-1 bg-slate-500 rounded-full" />
              Full dedicated instances — boot time 25–35 min
            </p>
            <QuickLaunchProfiles
              profiles={profiles}
              isLoading={isLoadingProfiles}
              launchingProfileId={launchingProfileId}
              onLaunch={handleLaunch}
              pinnedIds={pinnedIds}
              onTogglePin={togglePin}
            />
          </section>

          <div className="h-px w-full bg-gradient-to-r from-transparent via-white/5 to-transparent" />

          {/* Scheduler full config */}
          {schedulerConfig ? (
            <section>
              <SchedulerConfigCard
                config={schedulerConfig}
                profiles={profiles || []}
                onSave={handleSaveScheduler}
                isSaving={isSavingScheduler}
              />
            </section>
          ) : (
            <Skeleton className="h-48 w-full bg-white/5" />
          )}

          {/* Claim cleanup stats */}
          {cleanupStats && <ClaimCleanupCard stats={cleanupStats} />}

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

const PINNED_STORAGE_KEY = "floatr:pinned-profiles";

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
