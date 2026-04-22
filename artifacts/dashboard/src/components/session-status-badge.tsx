import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import type { SessionStatus } from "@workspace/api-client-react";

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  let colorClass = "bg-muted text-muted-foreground";

  switch (status) {
    case "pending":
    case "provisioning":
    case "downloading":
    case "starting":
      colorClass = "bg-blue-500/20 text-blue-400 border-blue-500/30";
      break;
    case "ready":
      colorClass = "bg-primary/20 text-primary border-primary/30";
      break;
    case "stopping":
    case "stopped":
      colorClass = "bg-muted text-muted-foreground border-border";
      break;
    case "error":
      colorClass = "bg-destructive/20 text-destructive border-destructive/30";
      break;
  }

  return (
    <Badge variant="outline" className={`font-mono text-xs uppercase ${colorClass}`}>
      {status}
    </Badge>
  );
}

export function TeamSessionBadge({ count }: { count: number }) {
  return (
    <Badge variant="outline" className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-xs gap-1 font-medium">
      <Users className="w-3 h-3" />
      Team · {count}
    </Badge>
  );
}
