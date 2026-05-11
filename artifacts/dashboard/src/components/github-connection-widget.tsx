import { useGitHubConnection } from "@/hooks/use-github-connection";
import { API_BASE_URL } from "@/lib/api-url";
import { Github, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GitHubConnectionWidget() {
  const { status, loading, disconnecting, disconnect } = useGitHubConnection();

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Checking GitHub connection…</span>
      </div>
    );
  }

  if (status.connected) {
    return (
      <div className="flex items-center gap-2">
        {status.avatarUrl && (
          <img
            src={status.avatarUrl}
            alt={status.login ?? "GitHub user"}
            className="w-5 h-5 rounded-full border border-border/50"
          />
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <Github className="w-3.5 h-3.5 text-foreground/70" />
          <span className="font-medium">{status.login}</span>
          <span className="text-muted-foreground">connected</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
          onClick={disconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <LogOut className="w-3 h-3" />
          )}
          <span className="ml-1">{disconnecting ? "Disconnecting…" : "Disconnect"}</span>
        </Button>
      </div>
    );
  }

  return (
    <a
      href={`${API_BASE_URL}api/auth/github`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-border/60 bg-background text-xs font-medium text-foreground hover:bg-secondary/40 transition-colors"
    >
      <Github className="w-3.5 h-3.5" />
      Connect GitHub
    </a>
  );
}
