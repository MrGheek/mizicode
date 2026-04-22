import { useGetRepoSummary } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACTIVE_STATUSES = new Set([
  "queued",
  "scanning",
  "fingerprinting",
  "indexing_graph",
  "indexing_fts",
  "indexing_vectors",
  "summarizing",
]);

type BadgeState = "loading" | "none" | "indexing" | "ready" | "stale" | "error" | "fetch_error";

function getBadgeState(indexStatus: string, isStale: boolean): BadgeState {
  if (indexStatus === "none") return "none";
  if (indexStatus === "error") return "error";
  if (ACTIVE_STATUSES.has(indexStatus)) return "indexing";
  if (indexStatus === "ready" && isStale) return "stale";
  if (indexStatus === "ready") return "ready";
  return "none";
}

const STATE_CONFIG: Record<BadgeState, { dot: string; label: string }> = {
  loading:     { dot: "bg-muted-foreground/20 animate-pulse",  label: "Loading…" },
  none:        { dot: "bg-muted-foreground/40",                label: "Not indexed" },
  indexing:    { dot: "bg-blue-400 animate-pulse",             label: "Indexing…" },
  ready:       { dot: "bg-emerald-400",                        label: "Indexed" },
  stale:       { dot: "bg-yellow-400",                         label: "Stale index" },
  error:       { dot: "bg-destructive",                        label: "Index error" },
  fetch_error: { dot: "bg-destructive/50",                     label: "Status unavailable" },
};

export function RepoIndexBadge({ sessionId }: { sessionId: number }) {
  const [, setLocation] = useLocation();

  const { data, isLoading, isError } = useGetRepoSummary(sessionId, {
    query: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });

  let state: BadgeState;
  if (isLoading) {
    state = "loading";
  } else if (isError) {
    state = "fetch_error";
  } else {
    state = getBadgeState(data?.indexStatus ?? "none", data?.isStale ?? false);
  }

  const config = STATE_CONFIG[state];

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLocation(`/sessions/${sessionId}?tab=repo`);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleClick}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border/40 bg-secondary/30 hover:bg-secondary/60 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Repo index: ${config.label}`}
        >
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0", config.dot)} />
          <span className="text-xs text-muted-foreground font-medium">Repo</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {config.label}
      </TooltipContent>
    </Tooltip>
  );
}
