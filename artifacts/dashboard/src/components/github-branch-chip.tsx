import { useState } from "react";
import { GitBranch, Copy, Check } from "lucide-react";

export function GitHubBranchChip({ sessionId }: { sessionId: number }) {
  const [copied, setCopied] = useState(false);
  const branch = `floatr/session-${sessionId}`;
  const handleCopy = () => {
    navigator.clipboard.writeText(branch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <button
      onClick={handleCopy}
      title="Copy branch name"
      className="inline-flex items-center gap-1 font-mono text-[11px] font-normal border border-border/50 bg-secondary/30 hover:bg-secondary/60 rounded px-1.5 py-0.5 transition-colors text-muted-foreground hover:text-foreground"
    >
      <GitBranch className="w-3 h-3 shrink-0" />
      {branch}
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 opacity-50" />}
    </button>
  );
}
