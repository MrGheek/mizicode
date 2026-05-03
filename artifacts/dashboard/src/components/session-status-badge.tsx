import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Users } from "lucide-react";
import type { SessionStatus, TeamMember } from "@workspace/api-client-react";

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

export function TeamSessionBadge({ members }: { members: TeamMember[] }) {
  const badge = (
    <Badge variant="outline" className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-xs gap-1 font-medium cursor-default">
      <Users className="w-3 h-3" />
      Team · {members.length}
    </Badge>
  );

  if (members.length === 0) {
    return badge;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col gap-0.5 text-left">
        {members.map((m) =>
          m.ideUrl ? (
            <a
              key={m.name}
              href={m.ideUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline text-violet-300"
            >
              {m.name}
            </a>
          ) : (
            <span key={m.name}>{m.name}</span>
          )
        )}
      </TooltipContent>
    </Tooltip>
  );
}
