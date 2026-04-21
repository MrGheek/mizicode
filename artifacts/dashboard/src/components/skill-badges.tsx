import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SkillClassBadge({ skillClass }: { skillClass: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    doctrine:   { label: "Doctrine",    cls: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
    workflow:   { label: "Workflow",    cls: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    context:    { label: "Context",     cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    efficiency: { label: "Efficiency",  cls: "bg-violet-500/20 text-violet-400 border-violet-500/30" },
    team:       { label: "Team",        cls: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
    repo:       { label: "Repo",        cls: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  };
  const entry = map[skillClass] ?? { label: skillClass, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <Badge variant="outline" className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0 ${entry.cls}`}>
      {entry.label}
    </Badge>
  );
}

export function TrustBadge({ trustTier }: { trustTier: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    floatr_native:  { label: "FLOATR Native",  cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    reviewed:       { label: "Reviewed",       cls: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    user_approved:  { label: "User Approved",  cls: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    experimental:   { label: "Experimental",   cls: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  };
  const entry = map[trustTier] ?? { label: trustTier, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <Badge variant="outline" className={`text-[10px] font-semibold px-1.5 py-0 ${entry.cls}`}>
      {entry.label}
    </Badge>
  );
}

export function TokenCostBadge({ tokens }: { tokens: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-muted/40 text-muted-foreground border-border/50 font-mono cursor-default">
          ~{tokens} tokens
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">Estimated token overhead per request</TooltipContent>
    </Tooltip>
  );
}

export function InstallRiskBadge({ installRisk }: { installRisk: string }) {
  const map: Record<string, { label: string; cls: string; tip: string }> = {
    virtual: { label: "Text only",  cls: "bg-secondary/50 text-muted-foreground border-border/50",         tip: "Pure instruction text — no code runs on your instance." },
    config:  { label: "Config",     cls: "bg-blue-500/20 text-blue-400 border-blue-500/30",                tip: "Writes config files to your instance." },
    hooked:  { label: "Hooks",      cls: "bg-orange-500/20 text-orange-400 border-orange-500/30",          tip: "Runs hook scripts on your instance on certain events." },
    binary:  { label: "Binary",     cls: "bg-red-500/20 text-red-400 border-red-500/30",                   tip: "Installs or runs binaries on your instance." },
  };
  const entry = map[installRisk] ?? { label: installRisk, cls: "bg-muted text-muted-foreground border-border", tip: "" };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 cursor-default ${entry.cls}`}>
          {entry.label}
        </Badge>
      </TooltipTrigger>
      {entry.tip && <TooltipContent side="top" className="text-xs max-w-[200px]">{entry.tip}</TooltipContent>}
    </Tooltip>
  );
}
