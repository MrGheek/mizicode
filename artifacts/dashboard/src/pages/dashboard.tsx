import { useState } from "react";
import { useLocation } from "wouter";
import { 
  useGetDashboardSummary, 
  useGetActiveSession, 
  useListProfiles, 
  useCreateSession,
  useListVolumes,
  useCreateVolume,
  useDeleteVolume,
  getGetDashboardSummaryQueryKey,
  getGetActiveSessionQueryKey,
  getListVolumesQueryKey,
} from "@workspace/api-client-react";
import type { Volume } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Clock, DollarSign, Server, Terminal, Play, ArrowRight, HardDrive, CheckCircle2, AlertCircle, Loader2, Trash2 } from "lucide-react";
import { ProfileCard } from "@/components/profile-card";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

function VolumeStatusBadge({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <Badge variant="default" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 gap-1">
        <CheckCircle2 className="w-3 h-3" /> Ready
      </Badge>
    );
  }
  if (status === "provisioning") {
    return (
      <Badge variant="outline" className="text-yellow-400 border-yellow-500/30 gap-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Downloading
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="text-red-400 border-red-500/30 gap-1">
        <AlertCircle className="w-3 h-3" /> Error
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1">
      <Loader2 className="w-3 h-3 animate-spin" /> Pending
    </Badge>
  );
}

function VolumeCard({ profileId, profileName, volume, onSetUp, onDelete, isSettingUp }: {
  profileId: number;
  profileName: string;
  volume: Volume | undefined;
  onSetUp: (profileId: number) => void;
  onDelete: (volumeId: number) => void;
  isSettingUp: boolean;
}) {
  if (!volume) {
    return (
      <div className="flex items-center justify-between p-4 rounded-lg border border-dashed border-border/60 bg-card/30">
        <div className="flex items-center gap-3">
          <HardDrive className="w-5 h-5 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium">{profileName}</p>
            <p className="text-xs text-muted-foreground">No volume — model downloads on each launch (~15-30 min)</p>
          </div>
        </div>
        <Button 
          size="sm" 
          variant="outline" 
          onClick={() => onSetUp(profileId)}
          disabled={isSettingUp}
          className="gap-2 shrink-0"
        >
          {isSettingUp ? <Loader2 className="w-3 h-3 animate-spin" /> : <HardDrive className="w-3 h-3" />}
          Set Up Volume
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border border-border/60 bg-card/50">
      <div className="flex items-center gap-3">
        <HardDrive className={`w-5 h-5 ${volume.status === "ready" ? "text-emerald-400" : "text-muted-foreground"}`} />
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{profileName}</p>
            <VolumeStatusBadge status={volume.status} />
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">
            {volume.name} • {volume.sizeGb} GB
            {volume.statusMessage && ` • ${volume.statusMessage}`}
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onDelete(volume.id)}
        className="text-muted-foreground hover:text-destructive shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [launchingProfileId, setLaunchingProfileId] = useState<number | null>(null);
  const [settingUpVolumeProfileId, setSettingUpVolumeProfileId] = useState<number | null>(null);

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: activeSessionResp, isLoading: isLoadingSession } = useGetActiveSession({
    query: { refetchInterval: 10000, queryKey: getGetActiveSessionQueryKey() }
  });
  const { data: profiles, isLoading: isLoadingProfiles } = useListProfiles();
  const { data: volumes, isLoading: isLoadingVolumes } = useListVolumes({
    query: { 
      queryKey: getListVolumesQueryKey(),
      refetchInterval: (query) => {
        const data = query.state.data as Volume[] | undefined;
        const hasProvisioning = data?.some(v => v.status === "provisioning" || v.status === "pending");
        return hasProvisioning ? 8000 : false;
      }
    }
  });

  const createSession = useCreateSession();
  const createVolume = useCreateVolume();
  const deleteVolume = useDeleteVolume();

  const volumeByProfileId = (volumes || []).reduce<Record<number, Volume>>((acc, v) => {
    if (v.profileId) acc[v.profileId] = v;
    return acc;
  }, {});

  const handleLaunch = (profileId: number) => {
    const volume = volumeByProfileId[profileId];
    const hasReadyVolume = volume?.status === "ready";

    if (!hasReadyVolume && !window.confirm(
      "No storage volume is set up for this profile.\n\n" +
      "The first launch will download the model (~15-30 minutes).\n\n" +
      "Continue anyway?"
    )) {
      return;
    }

    setLaunchingProfileId(profileId);
    createSession.mutate({ data: { profileId } }, {
      onSuccess: (session) => {
        toast({
          title: "Session Launched",
          description: hasReadyVolume
            ? "Fast start — loading model from volume."
            : "Provisioning — model download will begin.",
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

  const handleSetUpVolume = (profileId: number) => {
    setSettingUpVolumeProfileId(profileId);
    createVolume.mutate({ data: { profileId } }, {
      onSuccess: () => {
        toast({
          title: "Volume Provisioning Started",
          description: "A GPU instance is downloading the model weights. This takes 15-30 minutes.",
        });
        queryClient.invalidateQueries({ queryKey: getListVolumesQueryKey() });
        setSettingUpVolumeProfileId(null);
      },
      onError: (err: Error) => {
        toast({
          title: "Volume Setup Failed",
          description: err?.message || "Failed to set up volume.",
          variant: "destructive",
        });
        setSettingUpVolumeProfileId(null);
      }
    });
  };

  const handleDeleteVolume = (volumeId: number) => {
    if (!window.confirm("Delete this volume? This will destroy the cached model weights and cannot be undone.")) {
      return;
    }
    deleteVolume.mutate({ volumeId }, {
      onSuccess: () => {
        toast({ title: "Volume deleted" });
        queryClient.invalidateQueries({ queryKey: getListVolumesQueryKey() });
      },
      onError: (err: Error) => {
        toast({
          title: "Delete Failed",
          description: err?.message || "Failed to delete volume.",
          variant: "destructive",
        });
      }
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Active Session Panel */}
        <div className="col-span-1 lg:col-span-3">
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
                <p className="text-sm">Launch a profile below to get started.</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Storage Volumes */}
        <div className="col-span-1 lg:col-span-3">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-primary" /> Storage Volumes
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Pre-cache model weights so sessions start in ~3 min instead of 30 min
              </p>
            </div>
          </div>
          <Card className="bg-card/50">
            <CardContent className="p-4 space-y-3">
              {isLoadingProfiles || isLoadingVolumes ? (
                <Skeleton className="h-16 w-full" />
              ) : profiles?.length ? (
                profiles.map(profile => (
                  <VolumeCard
                    key={profile.id}
                    profileId={profile.id}
                    profileName={profile.displayName}
                    volume={volumeByProfileId[profile.id]}
                    onSetUp={handleSetUpVolume}
                    onDelete={handleDeleteVolume}
                    isSettingUp={settingUpVolumeProfileId === profile.id}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No GPU profiles configured.</p>
              )}
            </CardContent>
          </Card>
          {volumes?.some(v => v.status === "provisioning") && (
            <p className="text-xs text-muted-foreground mt-2 text-center animate-pulse">
              Volume provisioning in progress — checking every 8 seconds...
            </p>
          )}
        </div>

        {/* Quick Launch Profiles */}
        <div className="col-span-1 lg:col-span-3">
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
              profiles.map(profile => {
                const volume = volumeByProfileId[profile.id];
                const hasReadyVolume = volume?.status === "ready";
                return (
                  <ProfileCard 
                    key={profile.id} 
                    profile={profile} 
                    onLaunch={handleLaunch}
                    isLaunching={launchingProfileId === profile.id}
                    volumeStatus={volume?.status}
                    hasReadyVolume={hasReadyVolume}
                  />
                );
              })
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
