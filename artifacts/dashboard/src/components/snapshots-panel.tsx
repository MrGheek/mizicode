import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw, RefreshCw, GitCommit, AlertTriangle, Loader2, CheckCircle2, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

interface Snapshot {
  sha: string;
  tool: string;
  timestamp: string;
}

interface SnapshotsResponse {
  snapshots: Snapshot[];
}

function useSnapshots(sessionId: number) {
  return useQuery<SnapshotsResponse>({
    queryKey: ["snapshots", sessionId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/snapshots`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

function useRollback(sessionId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sha: string) => {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/snapshots/${sha}/rollback`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; sha: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["snapshots", sessionId] });
    },
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatTs(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function SnapshotsPanel({ sessionId }: { sessionId: number }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useSnapshots(sessionId);
  const rollback = useRollback(sessionId);
  const { toast } = useToast();
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const [rolledBackSha, setRolledBackSha] = useState<string | null>(null);

  const handleRollback = useCallback(async (sha: string) => {
    try {
      await rollback.mutateAsync(sha);
      setRolledBackSha(sha);
      setConfirmSha(null);
      toast({
        title: "Workspace rolled back",
        description: `Reset to snapshot ${shortSha(sha)} successfully.`,
      });
    } catch (err) {
      setConfirmSha(null);
      toast({
        title: "Rollback failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [rollback, toast]);

  const snapshots = data?.snapshots ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Workspace Snapshots</span>
          {snapshots.length > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {snapshots.length}
            </Badge>
          )}
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh snapshots</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        A snapshot is created automatically before each AI agent action. Roll back to any point to undo
        AI-induced file changes in the workspace.
      </p>

      {isLoading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading snapshots…</span>
        </div>
      )}

      {isError && (
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-6 text-center space-y-3">
            <AlertTriangle className="w-6 h-6 mx-auto text-amber-400" />
            <p className="text-sm text-muted-foreground">
              {(error as Error)?.message?.includes("Bridge not connected")
                ? "The session container is not connected. Snapshots are only available while the session is running."
                : ((error as Error)?.message ?? "Failed to load snapshots")}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && snapshots.length === 0 && (
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-8 text-center space-y-2">
            <GitCommit className="w-8 h-8 mx-auto opacity-20" />
            <p className="text-sm text-muted-foreground">No snapshots yet.</p>
            <p className="text-xs text-muted-foreground">
              Snapshots appear here after the AI agent executes its first action.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && snapshots.length > 0 && (
        <div className="space-y-2">
          {snapshots.map((snap, idx) => {
            const isLatest = idx === 0;
            const wasRolledBack = rolledBackSha === snap.sha;
            return (
              <Card
                key={snap.sha}
                className={`bg-card/50 border-border/50 transition-all ${wasRolledBack ? "border-emerald-500/50 bg-emerald-500/5" : ""}`}
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      {wasRolledBack ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <GitCommit className="w-4 h-4 text-muted-foreground/60" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-mono text-primary">{shortSha(snap.sha)}</code>
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 font-mono truncate max-w-[140px]"
                        >
                          {snap.tool}
                        </Badge>
                        {isLatest && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1.5 py-0 bg-primary/10 text-primary border-primary/30"
                          >
                            latest
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <Clock className="w-3 h-3 text-muted-foreground/50" />
                        <span className="text-[11px] text-muted-foreground">
                          {formatTs(snap.timestamp)}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs shrink-0 gap-1.5"
                      onClick={() => setConfirmSha(snap.sha)}
                      disabled={rollback.isPending}
                    >
                      <RotateCcw className="w-3 h-3" />
                      Roll back
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!confirmSha} onOpenChange={(open) => { if (!open) setConfirmSha(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-amber-400" />
              Roll back workspace?
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-muted-foreground">
              This will run{" "}
              <code className="bg-secondary px-1 rounded text-xs">git reset --hard {shortSha(confirmSha ?? "")}</code>{" "}
              in the container workspace. Any uncommitted changes made after this snapshot will be permanently lost.
            </p>
            {confirmSha && (
              <div className="rounded-lg bg-secondary/40 px-3 py-2 text-xs font-mono text-muted-foreground">
                Target: {confirmSha}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmSha(null)} disabled={rollback.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirmSha && handleRollback(confirmSha)}
              disabled={rollback.isPending}
              className="gap-2"
            >
              {rollback.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Roll back to this snapshot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
