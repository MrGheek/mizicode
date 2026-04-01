import { useLocation, useParams } from "wouter";
import {
  useGetSession,
  useDeleteSession,
  useRefreshSessionStatus,
  getGetSessionQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Terminal, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, ExternalLink, ArrowLeft
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function SessionDetail() {
  const { id } = useParams();
  const sessionId = id ? parseInt(id, 10) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useGetSession(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionQueryKey(sessionId),
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "ready" || s === "stopped" || s === "error" ? false : 5000;
      },
    }
  });

  const deleteSession = useDeleteSession();
  const refreshStatus = useRefreshSessionStatus();

  const handleStop = () => {
    if (!confirm("Stop and destroy this session? All data outside /workspace/projects will be lost.")) return;
    deleteSession.mutate({ sessionId }, {
      onSuccess: () => {
        toast({ title: "Session destroyed" });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      },
      onError: () => toast({ title: "Failed to stop session", variant: "destructive" }),
    });
  };

  const handleRefresh = () => {
    refreshStatus.mutate({ sessionId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) }),
      onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
    });
  };

  if (isLoading) {
    return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  }

  if (!session) {
    return <div className="p-8 text-destructive">Session not found</div>;
  }

  const isActive = session.status !== "stopped" && session.status !== "error";
  const isReady = session.status === "ready";

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">

      {/* Back */}
      <Button variant="ghost" className="gap-2 text-muted-foreground -ml-2" onClick={() => setLocation("/sessions")}>
        <ArrowLeft className="w-4 h-4" /> All Sessions
      </Button>

      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">Cockpit: {session.profileName}</h1>
            <SessionStatusBadge status={session.status} />
          </div>
          <p className="text-muted-foreground font-mono text-sm">
            Session #{session.id} · {session.gpuName} x{session.numGpus}
            {session.vastInstanceId ? ` · Vast #${session.vastInstanceId}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshStatus.isPending || !isActive}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${refreshStatus.isPending ? "animate-spin" : ""}`} />
            Sync
          </Button>
          {isActive && (
            <Button variant="destructive" size="sm" onClick={handleStop} disabled={deleteSession.isPending}>
              <StopCircle className="w-4 h-4 mr-1.5" />
              Destroy
            </Button>
          )}
        </div>
      </div>

      {/* Status message */}
      {session.statusMessage && (
        <div className="bg-secondary/30 border border-secondary p-4 rounded-md font-mono text-sm text-muted-foreground">
          {'>'} {session.statusMessage}
        </div>
      )}

      {/* Primary launch — shown when ready */}
      {isReady && session.boltDiyUrl ? (
        <Card className="border-primary/60 bg-primary/5">
          <CardContent className="pt-6 pb-6 flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
              <Terminal className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold mb-1">Your coding environment is ready</h2>
              <p className="text-sm text-muted-foreground">
                Bolt.diy with Kimi K2.5 AI — editor, terminal, and live preview all in one.
              </p>
            </div>
            <Button
              size="lg"
              className="gap-2 px-8"
              onClick={() => window.open(session.boltDiyUrl || "", "_blank")}
            >
              <ExternalLink className="w-4 h-4" />
              Open Coding Environment
            </Button>
          </CardContent>
        </Card>
      ) : isActive ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="pt-6 pb-6 flex flex-col items-center gap-3 text-center text-muted-foreground">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
              <Terminal className="w-6 h-6 animate-pulse" />
            </div>
            <p className="text-sm">Waiting for environment to start — this takes ~25 minutes on first launch while the model downloads.</p>
          </CardContent>
        </Card>
      ) : null}

      {/* Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <HardDrive className="w-4 h-4" /> Hardware & Access
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">GPU</span>
              <span className="font-mono">{session.gpuName || "—"} x{session.numGpus || "—"}</span>
            </div>
            <div className="flex justify-between border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Public IP</span>
              <span className="font-mono">{session.publicIp || "Pending"}</span>
            </div>
            {session.sshHost && (
              <div className="border-t border-border/40 pt-3">
                <span className="text-muted-foreground block mb-1">SSH</span>
                <code className="text-xs text-primary bg-secondary/50 px-2 py-1 rounded block break-all">
                  ssh -p {session.sshPort} root@{session.sshHost}
                </code>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <DollarSign className="w-4 h-4" /> Cost & Timing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Started</span>
              <span className="font-mono">
                {session.startedAt ? format(new Date(session.startedAt), "MMM d, HH:mm") : "—"}
              </span>
            </div>
            <div className="flex justify-between border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Rate</span>
              <span className="font-mono">${session.costPerHour?.toFixed(3) || "0.000"}/hr</span>
            </div>
            <div className="flex justify-between border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Total spend</span>
              <span className="font-mono text-primary font-semibold">
                ${session.totalCost?.toFixed(3) || "0.000"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
