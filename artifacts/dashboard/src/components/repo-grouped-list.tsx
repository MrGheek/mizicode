import { Check, Lock } from "lucide-react";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { GitHubRepo } from "@/hooks/use-github-repos";

interface RepoGroupedListProps {
  repos: GitHubRepo[];
  selectedCloneUrl: string;
  onSelect: (repo: GitHubRepo) => void;
}

/**
 * Renders a cmdk CommandList with repos grouped by owner/org.
 * Each owner becomes a CommandGroup heading; repos within each
 * group are sorted by the order returned from the API (updated desc).
 *
 * Extracted from LaunchSessionDialog so it can be unit-tested
 * in isolation without needing the full dialog context.
 */
export function RepoGroupedList({
  repos,
  selectedCloneUrl,
  onSelect,
}: RepoGroupedListProps) {
  const grouped = repos.reduce<Record<string, GitHubRepo[]>>((acc, repo) => {
    const key = repo.owner;
    if (!acc[key]) acc[key] = [];
    acc[key]!.push(repo);
    return acc;
  }, {});
  const owners = Object.keys(grouped).sort();

  return (
    <CommandList>
      <CommandEmpty>No repos found.</CommandEmpty>
      {owners.map((owner) => (
        <CommandGroup key={owner} heading={owner}>
          {grouped[owner]!.map((repo) => (
            <CommandItem
              key={repo.fullName}
              value={repo.fullName}
              onSelect={() => onSelect(repo)}
            >
              <Check
                className={`w-3.5 h-3.5 shrink-0 ${selectedCloneUrl === repo.cloneUrl ? "opacity-100" : "opacity-0"}`}
              />
              <span className="font-mono text-xs truncate flex-1">{repo.name}</span>
              {repo.private ? (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70 shrink-0">
                  <Lock className="w-2.5 h-2.5" />
                  Private
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground/50 shrink-0">Public</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </CommandList>
  );
}
