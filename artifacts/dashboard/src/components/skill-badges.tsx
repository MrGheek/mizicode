import { ThumbsUp, ThumbsDown, Minus, Clock, AlertCircle } from "lucide-react";
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

export interface FeedbackScoreEntry {
  helpfulRate: number;
  totalCount: number;
  decayedTotalWeight: number;
  decayedHelpfulWeight: number;
}

export interface SkillEffectivenessProps {
  slug: string;
  feedbackScores?: Record<string, FeedbackScoreEntry>;
}

/**
 * Returns a human-readable freshness label based on how much the decay-weighted
 * effective sample size has shrunk compared to the raw count.
 *
 * - Fresh:    decayedTotalWeight ≥ 80% of totalCount (recent signals dominate)
 * - Aging:    50–79% (mix of recent + older signals)
 * - Stale:    < 50% (feedback is mostly old and heavily discounted)
 */
export function getFreshnessInfo(decayedTotalWeight: number, totalCount: number): {
  label: string;
  tip: string;
  cls: string;
  icon: "fresh" | "aging" | "stale";
} {
  if (totalCount === 0) return { label: "No data", tip: "No feedback recorded yet.", cls: "text-muted-foreground/50", icon: "stale" };
  const ratio = decayedTotalWeight / totalCount;
  const recentN = Math.round(decayedTotalWeight);
  if (ratio >= 0.8) {
    return {
      label: `~${recentN} recent signals`,
      tip: `Signal is fresh — based on ~${recentN} recent signals out of ${totalCount} total. Recent feedback counts more in rankings.`,
      cls: "text-emerald-400",
      icon: "fresh",
    };
  }
  if (ratio >= 0.5) {
    return {
      label: `~${recentN} recent signals`,
      tip: `Signal is aging — effective weight is ~${recentN} out of ${totalCount} total ratings. Older feedback is time-discounted.`,
      cls: "text-amber-400",
      icon: "aging",
    };
  }
  return {
    label: `~${recentN} recent signals`,
    tip: `Signal is stale — older ratings are heavily discounted (effective weight ~${recentN} out of ${totalCount} total). Recency decay applied.`,
    cls: "text-orange-400",
    icon: "stale",
  };
}

/**
 * Shows an effectiveness badge based on aggregate feedback data.
 * Green = >70% helpful, Red = <40% helpful, Neutral = unknown or mixed.
 * Tooltip includes freshness information from time-decay weighting.
 */
export function SkillEffectivenessBadge({ slug, feedbackScores }: SkillEffectivenessProps) {
  const score = feedbackScores?.[slug];

  if (!score || score.totalCount < 2) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-muted/30 text-muted-foreground/60 border-border/40 cursor-default gap-0.5">
            <Minus className="w-2.5 h-2.5" />
            No data
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Not enough feedback yet to rate this skill.
        </TooltipContent>
      </Tooltip>
    );
  }

  const pct = Math.round(score.helpfulRate * 100);
  const freshness = getFreshnessInfo(score.decayedTotalWeight, score.totalCount);
  const freshnessNote = `${freshness.label} (${score.totalCount} total)`;

  if (score.helpfulRate >= 0.7) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-400 border-emerald-500/30 cursor-default gap-0.5">
            <ThumbsUp className="w-2.5 h-2.5" />
            {pct}% effective
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-[220px]">
          <p>Helpful in {pct}% of sessions</p>
          <p className={`mt-0.5 ${freshness.cls}`}>{freshnessNote}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (score.helpfulRate < 0.4) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-500/20 text-red-400 border-red-500/30 cursor-default gap-0.5">
            <ThumbsDown className="w-2.5 h-2.5" />
            {pct}% effective
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-[220px]">
          <p>Only helpful in {pct}% of sessions — may hurt more than help</p>
          <p className={`mt-0.5 ${freshness.cls}`}>{freshnessNote}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-yellow-500/20 text-yellow-400 border-yellow-500/30 cursor-default gap-0.5">
          <Minus className="w-2.5 h-2.5" />
          {pct}% effective
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-[220px]">
        <p>Helpful in {pct}% of sessions — mixed results</p>
        <p className={`mt-0.5 ${freshness.cls}`}>{freshnessNote}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Standalone freshness badge — shows whether a skill's feedback signals are
 * fresh, aging, or stale based on time-decay effective sample size.
 */
export function FreshnessBadge({ decayedTotalWeight, totalCount }: { decayedTotalWeight: number; totalCount: number }) {
  if (totalCount < 2) return null;
  const info = getFreshnessInfo(decayedTotalWeight, totalCount);

  const badgeCls = info.icon === "fresh"
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    : info.icon === "aging"
      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
      : "bg-orange-500/10 text-orange-400 border-orange-500/20";

  const Icon = info.icon === "fresh" ? Clock : info.icon === "aging" ? Clock : AlertCircle;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 cursor-default gap-0.5 ${badgeCls}`}>
          <Icon className="w-2.5 h-2.5" />
          {info.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-[240px]">
        {info.tip}
      </TooltipContent>
    </Tooltip>
  );
}
