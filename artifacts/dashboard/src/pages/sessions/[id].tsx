import { useEffect } from "react";
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
  Terminal, Server, Code2, Globe, Clock, DollarSign, RefreshCw, StopCircle, HardDrive, Network
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

  const { data: session, isLoading, refetch } = useGetSession(sessionId, {
    query: { 
      enabled: !!sessionId,
      queryKey: getGetSessionQueryKey(sessionId),
      refetchInterval: 5000,
    }
  });

  const deleteSession = useDeleteSession();
  const refreshStatus = useRefreshSessionStatus();

  const handleStop = () => {
    if (!confirm("Are you sure you want to stop and destroy this session? All unsaved data outside the workspace volume will be lost.")) return;
    
    deleteSession.mutate({ sessionId }, {
      onSuccess: () => {
        toast({ title: "Session stopping", description: "The instance is being destroyed." });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      },
      onError: () => {
        toast({ title: "Error stopping session", description: "Failed to stop session.", variant: "destructive" });
      }
    });
  };

  const handleRefresh = () => {
    refreshStatus.mutate({ sessionId }, {
      onSuccess: () => {
        toast({ title: "Status refreshed" });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      },
      onError: () => {
        toast({ title: "Refresh failed", description: "Could not refresh status.", variant: "destructive" });
      }
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
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">Cockpit: {session.profileName}</h1>
            <SessionStatusBadge status={session.status} />
          </div>
          <p className="text-muted-foreground font-mono">Session #{session.id} • Vast ID: {session.vastInstanceId || "Pending"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefresh} disabled={refreshStatus.isPending || !isActive}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshStatus.isPending ? "animate-spin" : ""}`} />
            Sync Status
          </Button>
          {isActive && (
            <Button variant="destructive" onClick={handleStop} disabled={deleteSession.isPending}>
              <StopCircle className="w-4 h-4 mr-2" />
              Destroy Session
            </Button>
          )}
        </div>
      </div>

      {session.statusMessage && (
        <div className="bg-secondary/30 border border-secondary p-4 rounded-md font-mono text-sm text-muted-foreground">
          {'>'} {session.statusMessage}
        </div>
      )}

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className={`bg-card/50 border-border/50 ${isReady ? 'border-primary/50' : ''}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" /> Bolt.diy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              AI-powered autonomous coding assistant.
            </p>
            <Button 
              className="w-full" 
              disabled={!isReady || !session.boltDiyUrl}
              onClick={() => window.open(session.boltDiyUrl || '', '_blank')}
            >
              Open Bolt
            </Button>
          </CardContent>
        </Card>

        <Card className={`bg-card/50 border-border/50 ${isReady ? 'border-primary/50' : ''}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Code2 className="w-5 h-5 text-primary" /> Code Server
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              VS Code in your browser.
            </p>
            <Button 
              className="w-full" 
              variant="secondary"
              disabled={!isReady || !session.codeServerUrl}
              onClick={() => window.open(session.codeServerUrl || '', '_blank')}
            >
              Open VS Code
            </Button>
          </CardContent>
        </Card>

        <Card className={`bg-card/50 border-border/50 ${isReady ? 'border-primary/50' : ''}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Globe className="w-5 h-5 text-primary" /> Preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Live app preview port (5173).
            </p>
            <Button 
              className="w-full" 
              variant="outline"
              disabled={!isReady || !session.previewUrl}
              onClick={() => window.open(session.previewUrl || '', '_blank')}
            >
              Open Preview
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-md flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-muted-foreground" /> Hardware
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between border-b border-border/50 pb-2">
              <span className="text-muted-foreground text-sm">GPU</span>
              <span className="font-mono text-sm">{session.gpuName || "Pending"} {session.numGpus ? `x${session.numGpus}` : ""}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 pb-2">
              <span className="text-muted-foreground text-sm">Template</span>
              <span className="font-mono text-sm break-all text-right max-w-[200px] truncate" title={session.templateHash || ""}>
                {session.templateHash || "Default"}
              </span>
            </div>
            <div className="flex justify-between pb-2">
              <span className="text-muted-foreground text-sm">SSH Access</span>
              <span className="font-mono text-sm text-primary">
                {session.sshHost ? `ssh -p ${session.sshPort} root@${session.sshHost}` : "Pending"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-md flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-muted-foreground" /> Lifecycle & Cost
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between border-b border-border/50 pb-2">
              <span className="text-muted-foreground text-sm">Created</span>
              <span className="font-mono text-sm">{format(new Date(session.createdAt), "MMM d, HH:mm")}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 pb-2">
              <span className="text-muted-foreground text-sm">Rate</span>
              <span className="font-mono text-sm">${session.costPerHour?.toFixed(3) || "0.000"}/hr</span>
            </div>
            <div className="flex justify-between pb-2">
              <span className="text-muted-foreground text-sm">Total Cost</span>
              <span className="font-mono text-sm text-primary font-bold">
                ${session.totalCost?.toFixed(3) || "0.000"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
