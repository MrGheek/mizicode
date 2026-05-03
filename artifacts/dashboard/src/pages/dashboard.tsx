import { useState, useMemo } from "react";
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
  getGetDashboardSummaryQueryKey,
  getGetActiveSessionQueryKey,
  getGetSchedulerConfigQueryKey,
  getCloneSessionQueryKey,
} from "@workspace/api-client-react";
import type { Session } from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { RelaunchButton } from "@/components/relaunch-button";
import { X, History } from "lucide-react";
import type { GpuProfile, SchedulerConfig, UpdateSchedulerRequest } from "@workspace/api-client-react";
import type { LaunchOptions } from "@/components/launch-session-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Clock, DollarSign, Server, Terminal, Play, ArrowRight, Target } from "lucide-react";
import { SwarmPill } from "@/components/swarm-activity-panel";
import { ProfileCard } from "@/components/profile-card";
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

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
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

  // "Continue where you left off" — most recent stopped session within the
  // last 7 days that has an intent text worth resuming. Hidden if there's an
  // active session, if no candidate exists, or if the user has dismissed
  // this specific session via localStorage.
  const continueCandidate = useMemo<Session | null>(() => {
    if (activeSession || !allSessions) return null;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const isDismissed = (id: number): boolean => {
      try {
        return localStorage.getItem(`floatr:continue-dismissed:${id}`) === "1";
      } catch {
        return false;
      }
    };
    // Filter out dismissed sessions BEFORE picking the most recent — this way
    // dismissing the top candidate falls through to the next eligible one.
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
    // dismissTick is included so that calling dismissContinue triggers a re-evaluation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, allSessions, dismissTick]);

  const dismissContinue = (sessionId: number) => {
    try {
      localStorage.setItem(`floatr:continue-dismissed:${sessionId}`, "1");
    } catch {
      // Ignore — dismissal is best-effort.
    }
    setDismissTick((n) => n + 1);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
          <p className="text-muted-foreground mt-1">Overview of your cloud GPU resources</p>
        </div>
      </div>

      {/* Continue where you left off */}
      {continueCandidate && (
        <ContinueCard session={continueCandidate} onDismiss={() => dismissContinue(continueCandidate.id)} />
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Sessions</CardTitle>
            <Activity className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold font-mono">{summary?.activeSessions || 0}</div>
            )}
          </CardContent>
        </Card>
        
        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Sessions</CardTitle>
            <Server className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold font-mono">{summary?.totalSessions || 0}</div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Compute Hours</CardTitle>
            <Clock className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold font-mono">{summary?.totalHours.toFixed(1) || 0}</div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Spend</CardTitle>
            <DollarSign className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold font-mono">${summary?.totalCost.toFixed(2) || "0.00"}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-8">
        {/* Active Session Panel */}
        <div>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Terminal className="w-5 h-5 text-primary" /> Active Session
          </h2>
          {isLoadingSession ? (
            <Skeleton className="h-32 w-full" />
          ) : activeSession ? (
            <Card className="border-primary/50 bg-primary/5">
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <h3 className="text-lg font-bold">{activeSession.profileName}</h3>
                    <SessionStatusBadge status={activeSession.status} />
                    {activeSession.teamMembers && activeSession.teamMembers.length > 0 && <TeamSessionBadge members={activeSession.teamMembers} />}
                    <SwarmPill sessionId={activeSession.id} isReady={activeSession.status === "ready"} />
                  </div>
                  <p className="text-sm text-muted-foreground font-mono">
                    {activeSession.gpuName} x{activeSession.numGpus} • ${activeSession.costPerHour?.toFixed(2) || "0.00"}/hr
                  </p>
                  {activeSession.statusMessage && (
                    <p className="text-xs text-muted-foreground mt-2 italic">"{activeSession.statusMessage}"</p>
                  )}
                </div>
                <Button 
                  onClick={() => setLocation(`/sessions/${activeSession.id}`)}
                  className="gap-2"
                >
                  View Cockpit <ArrowRight className="w-4 h-4" />
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed bg-transparent border-border/60">
              <CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center">
                <Terminal className="w-8 h-8 mb-3 opacity-20" />
                <p>No active session currently running.</p>
                <p className="text-sm">Launch a profile below or configure the scheduler.</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Session Scheduler */}
        {schedulerConfig ? (
          <div>
            <SchedulerConfigCard
              config={schedulerConfig}
              profiles={profiles || []}
              onSave={handleSaveScheduler}
              isSaving={isSavingScheduler}
            />
          </div>
        ) : (
          <Skeleton className="h-48 w-full" />
        )}

        {/* Quick Launch Profiles */}
        <QuickLaunchProfiles
          profiles={profiles}
          isLoading={isLoadingProfiles}
          launchingProfileId={launchingProfileId}
          onLaunch={handleLaunch}
        />
      </div>
    </div>
  );
}

interface ContinueCardProps {
  session: Session;
  onDismiss: () => void;
}

/**
 * Derive a friendly project name from a Git repo URL — works for HTTPS
 * (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 * Returns null if no recognisable project segment can be extracted.
 */
function projectNameFromRepoUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  // SSH-style: git@host:owner/repo
  const sshMatch = trimmed.match(/[:/]([^/:]+\/[^/:]+)$/);
  if (sshMatch) return sshMatch[1];
  // HTTP-style: take last two path segments if available
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (parts.length === 1) return parts[0];
  } catch {
    // Fall through to last segment
  }
  const lastSegment = trimmed.split("/").pop();
  return lastSegment || null;
}

function ContinueCard({ session, onDismiss }: ContinueCardProps) {
  const stoppedRef = session.stoppedAt ? new Date(session.stoppedAt) : new Date(session.createdAt);
  const ago = formatDistanceToNow(stoppedRef, { addSuffix: true });
  const cost = session.totalCost?.toFixed(2) ?? "0.00";
  const intent = session.intentText ?? "";
  // Lazy-fetch the clone payload to recover the repo URL → project name.
  // The `Session` list type doesn't expose repoUrl, so we piggyback on the
  // cheap clone endpoint (read-only, already used by the Re-launch flow).
  const { data: cloneData } = useCloneSession(session.id, {
    query: { queryKey: getCloneSessionQueryKey(session.id), staleTime: 60_000 },
  });
  const projectName = projectNameFromRepoUrl(cloneData?.repoUrl);
  return (
    <Card className="border-primary/40 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent relative">
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss continue-where-you-left-off card"
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
        data-testid="button-dismiss-continue"
      >
        <X className="w-4 h-4" />
      </button>
      <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="rounded-full bg-primary/15 p-2 mt-0.5 shrink-0">
            <History className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-bold">Continue where you left off</h3>
              {projectName && (
                <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                  {projectName}
                </span>
              )}
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {session.profileName} · {ago}
              </span>
            </div>
            <p className="text-sm text-foreground/90 mt-1 flex items-start gap-1.5">
              <Target className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              <span className="line-clamp-2">{intent}</span>
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-1.5">
              Last run cost ${cost} · Session #{session.id}
            </p>
          </div>
        </div>
        <RelaunchButton sessionId={session.id} variant="prominent" label="Re-launch" />
      </CardContent>
    </Card>
  );
}

const MODEL_BENCHMARKS: Record<string, string> = {
  "Kimi K2.6":          "65.8% SWE-Bench Verified",
  "Kimi K2.5":          "63.6% SWE-Bench Verified · legacy",
  "Qwen3-Coder-Next":   "Highest open-weight SWE-Bench score per dollar",
  "MiniMax M2.5":       "80.2% SWE-Bench Verified",
  "GLM-5.1 (FP8)":      "58.4% SWE-Bench Pro · open-weight record",
  "DeepSeek V3.2":      "671B MIT-licensed · strong multilingual coding",
};

interface QuickLaunchProfilesProps {
  profiles: GpuProfile[] | undefined;
  isLoading: boolean;
  launchingProfileId: number | null;
  onLaunch: (profileId: number, opts?: Omit<LaunchOptions, "profileId">) => void;
}

const SWARM_CONSTRAINED_CAP = 8;

function isSwarmConstrained(profile: GpuProfile): boolean {
  const cap = profile.swarmWorkerCap ?? 0;
  return cap > 0 && cap <= SWARM_CONSTRAINED_CAP;
}

function QuickLaunchProfiles({ profiles, isLoading, launchingProfileId, onLaunch }: QuickLaunchProfilesProps) {
  const sortedProfiles = useMemo(() => {
    if (!profiles) return [];
    return [...profiles].sort((a, b) => {
      const ac = isSwarmConstrained(a) ? 1 : 0;
      const bc = isSwarmConstrained(b) ? 1 : 0;
      return ac - bc;
    });
  }, [profiles]);

  const modelGroups = useMemo(() => {
    if (!profiles) return [];
    const groupMap = new Map<string, GpuProfile[]>();
    for (const profile of profiles) {
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
  }, [profiles]);

  const isGrouped = modelGroups.length >= 2;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Play className="w-5 h-5 text-primary" /> Quick Launch Profiles
        </h2>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : !profiles?.length ? (
        <div className="p-8 text-center border border-dashed rounded-lg border-border/60 text-muted-foreground">
          No GPU profiles configured.
        </div>
      ) : isGrouped ? (
        <div className="space-y-8">
          {modelGroups.map(({ model, items }, groupIdx) => (
            <div key={model}>
              <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-border/40">
                <h3 className="text-base font-semibold">{model}</h3>
                <span className="text-xs text-muted-foreground">
                  {MODEL_BENCHMARKS[model] ?? "Open-weight model"}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {items.map((profile, idx) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    onLaunch={onLaunch}
                    isLaunching={launchingProfileId === profile.id}
                    isDefaultLaunch={groupIdx === 0 && idx === 0}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedProfiles.map((profile, idx) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              onLaunch={onLaunch}
              isLaunching={launchingProfileId === profile.id}
              isDefaultLaunch={idx === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
