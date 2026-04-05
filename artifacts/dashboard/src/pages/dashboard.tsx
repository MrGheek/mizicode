import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { 
  useGetDashboardSummary, 
  useGetActiveSession, 
  useListProfiles, 
  useCreateSession,
  useGetSchedulerConfig,
  useUpdateSchedulerConfig,
  getGetDashboardSummaryQueryKey,
  getGetActiveSessionQueryKey,
  getGetSchedulerConfigQueryKey,
} from "@workspace/api-client-react";
import type { SchedulerConfig, UpdateSchedulerRequest } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Clock, DollarSign, Server, Terminal, Play, ArrowRight } from "lucide-react";
import { ProfileCard } from "@/components/profile-card";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { SchedulerConfigCard } from "@/components/scheduler-config-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { getLocalHHMM } from "@/lib/time-utils";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [launchingProfileId, setLaunchingProfileId] = useState<number | null>(null);
  const [isSavingScheduler, setIsSavingScheduler] = useState(false);

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: activeSessionResp, isLoading: isLoadingSession } = useGetActiveSession({
    query: { refetchInterval: 10000, queryKey: getGetActiveSessionQueryKey() }
  });
  const { data: profiles, isLoading: isLoadingProfiles } = useListProfiles();
  const { data: schedulerConfig } = useGetSchedulerConfig({
    query: { queryKey: getGetSchedulerConfigQueryKey() }
  });

  const createSession = useCreateSession();
  const updateScheduler = useUpdateSchedulerConfig();

  // Second reminder: show a toast at secondReminderTime
  useEffect(() => {
    if (!schedulerConfig?.enabled) return;

    const interval = setInterval(() => {
      const localTime = getLocalHHMM(schedulerConfig.timezone);
      if (localTime === schedulerConfig.secondReminderTime) {
        toast({
          title: "Session Launching Tomorrow",
          description: `Your coding session will auto-start at ${schedulerConfig.launchTime} (${schedulerConfig.timezone.replace(/_/g, " ")}).`,
          duration: 10000,
        });
      }
    }, 60 * 1000);

    return () => clearInterval(interval);
  }, [schedulerConfig, toast]);

  const handleLaunch = (profileId: number) => {
    setLaunchingProfileId(profileId);
    createSession.mutate({ data: { profileId } }, {
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

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
          <p className="text-muted-foreground mt-1">Overview of your cloud GPU resources</p>
        </div>
      </div>

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
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-bold">{activeSession.profileName}</h3>
                    <SessionStatusBadge status={activeSession.status} />
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
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" /> Quick Launch Profiles
            </h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {isLoadingProfiles ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-64 w-full" />
              ))
            ) : profiles?.length ? (
              profiles.map(profile => (
                <ProfileCard 
                  key={profile.id} 
                  profile={profile} 
                  onLaunch={handleLaunch}
                  isLaunching={launchingProfileId === profile.id}
                />
              ))
            ) : (
              <div className="col-span-3 p-8 text-center border border-dashed rounded-lg border-border/60 text-muted-foreground">
                No GPU profiles configured.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
