import { useLocation } from "wouter";
import { useListSessions, getListSessionsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Terminal, Eye, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SessionStatusBadge, TeamSessionBadge } from "@/components/session-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SwarmPill } from "@/components/swarm-activity-panel";

export default function SessionsList() {
  const [, setLocation] = useLocation();
  const { data: sessions, isLoading } = useListSessions();

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
          <p className="text-muted-foreground mt-1">History of all active and past coding sessions</p>
        </div>
        <Button onClick={() => setLocation("/")} className="gap-2">
          <Plus className="w-4 h-4" /> New Session
        </Button>
      </div>

      <div className="border border-border/50 rounded-lg bg-card/50 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50 bg-secondary/20">
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Hardware</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-8 w-8 ml-auto rounded" /></TableCell>
                </TableRow>
              ))
            ) : sessions?.length ? (
              sessions.map((session) => (
                <TableRow key={session.id} className="border-border/50">
                  <TableCell className="font-mono text-muted-foreground">#{session.id}</TableCell>
                  <TableCell className="font-medium">{session.profileName}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 flex-wrap">
                      <SessionStatusBadge status={session.status} />
                      {session.teamMembers && session.teamMembers.length > 0 && <TeamSessionBadge />}
                      <SwarmPill sessionId={session.id} isReady={session.status === "ready"} />
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {session.gpuName ? `${session.gpuName} x${session.numGpus}` : 'N/A'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {format(new Date(session.createdAt), "MMM d, yyyy HH:mm")}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${session.totalCost?.toFixed(2) || "0.00"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setLocation(`/sessions/${session.id}`)}
                      title="View Details"
                    >
                      <Eye className="w-4 h-4 text-primary" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  No sessions found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
