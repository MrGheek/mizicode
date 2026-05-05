import { useState, useEffect, useRef } from "react";
import {
  useListSkills,
  useImportSkill,
  useReviewSkill,
  useEnableSkill,
  useDisableSkill,
  useListSkillBundles,
  useGetSkill,
  getListSkillsQueryKey,
  useGetSkillFeedbackScores,
  useGetSkillFeedbackHistory,
  useDeleteSkillFeedbackEntry,
  useClearAllSkillFeedback,
  getGetSkillFeedbackHistoryQueryKey,
  getGetSkillFeedbackScoresQueryKey,
} from "@workspace/api-client-react";
import type { SkillRecord, SkillBundle, SkillFeedbackHistoryEntry } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  Wand2, Plus, ExternalLink, AlertTriangle, ChevronDown, ChevronRight,
  Loader2, CheckCircle, XCircle, Package, GitBranch, Key, Scale,
  ThumbsUp, ThumbsDown, Trash2, MessageSquare, Palette, Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { SkillClassBadge, TrustBadge, TokenCostBadge, InstallRiskBadge, SkillEffectivenessBadge, FreshnessBadge, getFreshnessInfo } from "@/components/skill-badges";
import { categoryIcon } from "@/lib/design-intelligence";
import type { FeedbackScoreEntry } from "@/components/skill-badges";

type LibTab = "installed" | "pending" | "disabled" | "bundles";

const FALLBACK_DEFAULT_SLUGS = ["mizi-builder", "mizi-reviewer", "mizi-debugger", "mizi-team-studio"];
const BASE_URL = import.meta.env.BASE_URL ?? "/";

type ManifestSource = { repoUrl?: string; commitSha?: string; license?: string; trust?: string };
type SkillManifest = {
  id?: string; name?: string; class?: string; summary?: string;
  instructions?: string[];
  source?: ManifestSource;
  cost?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
  triggers?: string[];
};

function SkillSourceBlock({ skillId, alwaysOpen }: { skillId: number; alwaysOpen?: boolean }) {
  const [open, setOpen] = useState(alwaysOpen ?? false);
  const { data, isLoading } = useGetSkill(skillId);
  const manifest = data?.latestManifest as SkillManifest | undefined;
  const src = manifest?.source;

  return (
    <div className="rounded border border-border/40 bg-secondary/20 text-xs">
      {!alwaysOpen && (
        <button
          className="w-full flex items-center justify-between px-2.5 py-2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <span className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
            <GitBranch className="w-3 h-3 shrink-0" />
            {src?.repoUrl ? (
              <a
                href={src.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary/80 hover:text-primary underline underline-offset-2 truncate"
                onClick={e => e.stopPropagation()}
              >
                {src.repoUrl.replace("https://github.com/", "")}
                <ExternalLink className="inline w-2.5 h-2.5 ml-0.5 mb-0.5" />
              </a>
            ) : (
              <span>Source & Manifest</span>
            )}
          </span>
          {open ? <ChevronDown className="w-3 h-3 shrink-0 ml-1" /> : <ChevronRight className="w-3 h-3 shrink-0 ml-1" />}
        </button>
      )}
      {(alwaysOpen || open) && (
        <div className="px-2.5 pb-2.5 space-y-2" style={alwaysOpen ? { paddingTop: "0.625rem" } : {}}>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading provenance…
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <GitBranch className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="text-muted-foreground mr-1">Repo:</span>
                  {src?.repoUrl ? (
                    <a
                      href={src.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary/80 hover:text-primary underline underline-offset-2 break-all"
                    >
                      {src.repoUrl.replace("https://github.com/", "")}
                      <ExternalLink className="inline w-2.5 h-2.5 ml-0.5 mb-0.5" />
                    </a>
                  ) : <span className="font-mono text-muted-foreground/60">—</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Key className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Commit SHA:</span>
                <span className="font-mono text-[10px] text-primary/80">
                  {src?.commitSha ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Scale className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">License:</span>
                <span className="font-mono text-primary/80">{src?.license ?? "—"}</span>
              </div>
              <details className="border-t border-border/30 pt-2 mt-1">
                <summary className="cursor-pointer select-none text-[10px] font-semibold text-foreground/50 uppercase tracking-wide hover:text-foreground/80 transition-colors">
                  Manifest Details
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  {manifest?.instructions && manifest.instructions.length > 0 && (
                    <ul className="space-y-0.5 list-disc list-inside text-muted-foreground">
                      {manifest.instructions.map((line, i) => (
                        <li key={i} className="text-[10px] leading-relaxed">{line}</li>
                      ))}
                    </ul>
                  )}
                  {manifest?.triggers && manifest.triggers.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-muted-foreground">Triggers:</span>
                      {manifest.triggers.map(t => (
                        <Badge key={t} variant="outline" className="text-[9px] py-0 h-4">{t}</Badge>
                      ))}
                    </div>
                  )}
                  {!manifest?.instructions?.length && !manifest?.triggers?.length && (
                    <pre className="bg-secondary/40 rounded p-2 overflow-x-auto text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all">
                      {manifest ? JSON.stringify(manifest, null, 2) : "No manifest data available."}
                    </pre>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DesignCategoryPills({ categories }: { categories: string[] }) {
  if (categories.length === 0) return null;
  const visible = categories.slice(0, 2);
  const overflow = categories.length - visible.length;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map((cat) => (
        <Badge
          key={cat}
          variant="outline"
          className="text-[10px] py-0 h-4 gap-0.5 border-primary/30 text-primary/70 bg-primary/5"
        >
          <span>{categoryIcon(cat)}</span>
          <span className="capitalize ml-0.5">{cat}</span>
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground/60">+{overflow} more</span>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  showProvenance,
  showActions,
  onApprove,
  onReject,
  onToggle,
  isActioning,
  feedbackScores,
  designCategories,
  onClick,
}: {
  skill: SkillRecord;
  showProvenance?: boolean;
  showActions?: "review" | "toggle";
  onApprove?: () => void;
  onReject?: () => void;
  onToggle?: () => void;
  isActioning?: boolean;
  feedbackScores?: Record<string, FeedbackScoreEntry>;
  designCategories?: string[];
  onClick?: () => void;
}) {
  const isHighRisk = skill.installRisk === "hooked" || skill.installRisk === "binary";

  return (
    <Card
      className={`bg-card/50 border-border/50 ${onClick ? "cursor-pointer hover:border-primary/50 transition-colors" : ""}`}
      onClick={onClick}
    >
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <SkillClassBadge skillClass={skill.class} />
              <TrustBadge trustTier={skill.trustTier} />
              <InstallRiskBadge installRisk={skill.installRisk} />
              {skill.tokenOverheadEstimate != null && (
                <TokenCostBadge tokens={skill.tokenOverheadEstimate} />
              )}
              {feedbackScores && (
                <SkillEffectivenessBadge slug={skill.slug} feedbackScores={feedbackScores} />
              )}
            </div>
            <h3 className="font-semibold text-sm mt-1">{skill.name}</h3>
            {skill.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
            )}
            {designCategories && designCategories.length > 0 && (
              <div className="mt-1.5">
                <DesignCategoryPills categories={designCategories} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showActions === "toggle" && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
                disabled={isActioning}
              >
                {isActioning ? <Loader2 className="w-3 h-3 animate-spin" /> : (skill.enabled ? "Disable" : "Enable")}
              </Button>
            )}
          </div>
        </div>

        {showProvenance && (
          <SkillSourceBlock skillId={skill.id} alwaysOpen />
        )}

        {!showProvenance && showActions === "toggle" && (
          <SkillSourceBlock skillId={skill.id} />
        )}

        {showActions === "review" && (
          <div className="space-y-2">
            {isHighRisk && (
              <div className="flex items-start gap-2 px-2.5 py-1.5 rounded bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>This skill runs code on your instance — review carefully before approving.</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1 h-8 text-xs bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border-emerald-600/30"
                variant="outline"
                onClick={(e) => { e.stopPropagation(); onApprove?.(); }}
                disabled={isActioning}
              >
                {isActioning ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <CheckCircle className="w-3 h-3 mr-1.5" />}
                Approve
              </Button>
              <Button
                size="sm"
                className="flex-1 h-8 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-600/30"
                variant="outline"
                onClick={(e) => { e.stopPropagation(); onReject?.(); }}
                disabled={isActioning}
              >
                <XCircle className="w-3 h-3 mr-1.5" />
                Reject
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type CompiledSkill = {
  id?: string | number;
  name?: string;
  class?: string;
  summary?: string;
  instructions?: { system?: string[] } | string[];
  source?: ManifestSource;
  install?: { type?: string; outputs?: string[] };
  cost?: { tokenOverheadEstimate?: number };
  triggers?: string[];
};

function BundleSkillAccordion({ skill, index }: { skill: CompiledSkill; index: number }) {
  const [open, setOpen] = useState(false);
  const instructions: string[] = Array.isArray(skill.instructions)
    ? skill.instructions
    : Array.isArray((skill.instructions as { system?: string[] })?.system)
      ? (skill.instructions as { system: string[] }).system
      : [];
  const installRisk = skill.install?.type;
  const trustTier = skill.source?.trust;
  const tokenCost = skill.cost?.tokenOverheadEstimate;

  return (
    <div className="border border-border/40 rounded-lg">
      <button
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-secondary/20 transition-colors rounded-lg"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {skill.class && <SkillClassBadge skillClass={skill.class} />}
          {trustTier && <TrustBadge trustTier={trustTier} />}
          {installRisk && <InstallRiskBadge installRisk={installRisk} />}
          {tokenCost != null && <TokenCostBadge tokens={tokenCost} />}
          <span className="font-medium text-sm">{skill.name ?? `Skill ${index + 1}`}</span>
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/40 pt-2.5 text-xs text-muted-foreground">
          {skill.summary && <p>{skill.summary}</p>}
          {instructions.length > 0 && (
            <div>
              <p className="font-semibold text-foreground/70 mb-1.5 text-[10px] uppercase tracking-wide">Instructions</p>
              <ul className="space-y-0.5 list-disc list-inside">
                {instructions.map((line, j) => <li key={j} className="leading-relaxed">{line}</li>)}
              </ul>
            </div>
          )}
          {skill.source && (
            <div className="border-t border-border/30 pt-2.5 space-y-1.5">
              <p className="font-semibold text-foreground/70 mb-1 text-[10px] uppercase tracking-wide">Provenance</p>
              {skill.source.repoUrl && (
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3 h-3 shrink-0" />
                  <a href={skill.source.repoUrl} target="_blank" rel="noopener noreferrer"
                    className="text-primary/80 hover:text-primary underline underline-offset-2 break-all">
                    {skill.source.repoUrl.replace("https://github.com/", "")}
                    <ExternalLink className="inline w-2.5 h-2.5 ml-0.5 mb-0.5" />
                  </a>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Key className="w-3 h-3 shrink-0" />
                <span className="font-mono text-[10px]">SHA: {skill.source.commitSha ?? "—"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Scale className="w-3 h-3 shrink-0" />
                <span>{skill.source.license ?? "—"}</span>
              </div>
            </div>
          )}
          {skill.triggers && skill.triggers.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px]">Triggers:</span>
              {skill.triggers.map(t => (
                <Badge key={t} variant="outline" className="text-[9px] py-0 h-4">{t}</Badge>
              ))}
            </div>
          )}
          <details className="border-t border-border/30 pt-2">
            <summary className="cursor-pointer select-none text-[10px] font-semibold text-foreground/50 uppercase tracking-wide hover:text-foreground/80 transition-colors">
              Full Manifest JSON
            </summary>
            <pre className="mt-1.5 bg-secondary/40 rounded p-2 overflow-x-auto text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all">
              {JSON.stringify(skill, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

type DesignCategoryEntry = { name: string; isManual: boolean; isComputed: boolean };


function SkillDesignCategoriesPanel({ skillId }: { skillId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingCat, setPendingCat] = useState<string | null>(null);

  const queryKey = ["skill-design-categories", skillId];
  const { data, isLoading } = useQuery<{ categories: DesignCategoryEntry[] }>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/skills/${skillId}/design-categories`);
      if (!res.ok) throw new Error("Failed to load design categories");
      return res.json();
    },
    staleTime: 30000,
  });

  const categories = data?.categories ?? [];
  const hasAny = categories.some((c) => c.isManual || c.isComputed);

  const handleToggle = async (cat: DesignCategoryEntry) => {
    if (pendingCat) return;
    setPendingCat(cat.name);
    try {
      if (cat.isManual) {
        const res = await fetch(`${BASE_URL}api/skills/${skillId}/design-categories/${encodeURIComponent(cat.name)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("Failed to remove link");
        toast({ title: `Removed manual link: "${cat.name}"` });
      } else {
        const res = await fetch(`${BASE_URL}api/skills/${skillId}/design-categories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: cat.name }),
        });
        if (!res.ok) throw new Error("Failed to add link");
        toast({ title: `Linked "${cat.name}" to this skill` });
      }
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["getSkill", skillId] });
    } catch (err) {
      toast({ title: (err as Error).message || "Action failed", variant: "destructive" });
    } finally {
      setPendingCat(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No design categories available. Sync design intelligence data first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground/70">
        Check categories to manually link them. Auto-detected links are shown with{" "}
        <span className="text-sky-400">auto</span> and cannot be unchecked here.
      </p>
      {!hasAny && (
        <p className="text-xs text-muted-foreground/60 italic py-1">
          No categories currently linked. Check any below to add a manual link.
        </p>
      )}
      <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
        {categories.map((cat) => {
          const isLinked = cat.isManual || cat.isComputed;
          const isBusy = pendingCat === cat.name;
          return (
            <div
              key={cat.name}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded text-xs transition-colors ${
                isLinked
                  ? "bg-primary/5 border border-primary/20"
                  : "border border-transparent hover:bg-secondary/30"
              } ${cat.isComputed && !cat.isManual ? "opacity-80" : ""}`}
            >
              {cat.isComputed && !cat.isManual ? (
                <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                  <span className="w-2.5 h-2.5 rounded-sm bg-sky-500/30 border border-sky-500/50" />
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!!pendingCat}
                  onClick={() => handleToggle(cat)}
                  className={`w-4 h-4 shrink-0 rounded-sm border flex items-center justify-center transition-colors focus:outline-none ${
                    cat.isManual
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-border/60 hover:border-primary/60"
                  } ${!!pendingCat ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  aria-label={cat.isManual ? `Remove manual link for ${cat.name}` : `Add manual link for ${cat.name}`}
                >
                  {isBusy ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  ) : cat.isManual ? (
                    <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </button>
              )}
              <span className={`flex items-center gap-1.5 min-w-0 flex-1 ${isLinked ? "text-foreground" : "text-muted-foreground"}`}>
                <span className="shrink-0">{categoryIcon(cat.name)}</span>
                <span className="capitalize truncate">{cat.name}</span>
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {cat.isManual && (
                  <Badge variant="outline" className="text-[9px] py-0 h-4 border-primary/40 text-primary/70">
                    manual
                  </Badge>
                )}
                {cat.isComputed && (
                  <Badge variant="outline" className="text-[9px] py-0 h-4 border-sky-500/40 text-sky-400">
                    auto
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const FEEDBACK_PAGE_LIMIT = 50;

function FeedbackHistoryPanel({ skillId, feedbackScore }: { skillId: number; feedbackScore?: FeedbackScoreEntry }) {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<Map<number, SkillFeedbackHistoryEntry[]>>(new Map());
  const lastAggregateRef = useRef({ helpfulRate: 0, totalCount: 0, helpfulCount: 0, unhelpfulCount: 0 });
  const deleteMutation = useDeleteSkillFeedbackEntry();
  const clearAllMutation = useClearAllSkillFeedback();
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const { toast } = useToast();

  const { data, isLoading, isError, isFetching } = useGetSkillFeedbackHistory(
    skillId,
    { limit: FEEDBACK_PAGE_LIMIT, offset },
  );

  useEffect(() => {
    setOffset(0);
    setPages(new Map());
    lastAggregateRef.current = { helpfulRate: 0, totalCount: 0, helpfulCount: 0, unhelpfulCount: 0 };
  }, [skillId]);

  useEffect(() => {
    if (!data) return;
    lastAggregateRef.current = {
      helpfulRate: data.helpfulRate,
      totalCount: data.totalCount,
      helpfulCount: data.helpfulCount,
      unhelpfulCount: data.unhelpfulCount,
    };
    setPages(prev => {
      const next = new Map(prev);
      next.set(offset, data.history);
      return next;
    });
  }, [data, offset]);

  const allHistory = Array.from(pages.entries())
    .sort(([a], [b]) => a - b)
    .flatMap(([, entries]) => entries);

  const handleDelete = (entry: SkillFeedbackHistoryEntry) => {
    deleteMutation.mutate({ skillId, feedbackId: entry.id }, {
      onSuccess: () => {
        toast({ title: "Feedback entry removed" });
        setOffset(0);
        setPages(new Map());
        lastAggregateRef.current = { helpfulRate: 0, totalCount: 0, helpfulCount: 0, unhelpfulCount: 0 };
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackHistoryQueryKey(skillId) });
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackScoresQueryKey() });
      },
      onError: () => toast({ title: "Failed to remove entry", variant: "destructive" }),
    });
  };

  const handleClearAll = () => {
    clearAllMutation.mutate({ skillId }, {
      onSuccess: () => {
        toast({ title: "All feedback cleared" });
        setShowClearConfirm(false);
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackHistoryQueryKey(skillId) });
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackScoresQueryKey() });
      },
      onError: () => toast({ title: "Failed to clear feedback", variant: "destructive" }),
    });
  };

  if (isLoading && allHistory.length === 0) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (isError && allHistory.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4">
        Could not load feedback history.
      </p>
    );
  }

  const { helpfulRate, totalCount, helpfulCount, unhelpfulCount } = lastAggregateRef.current;
  const hasMore = totalCount > 0 && allHistory.length < totalCount;

  const handleLoadMore = () => {
    setOffset(allHistory.length);
  };

  const decayedTotalWeight = feedbackScore?.decayedTotalWeight ?? totalCount;
  const freshnessInfo = totalCount > 0 ? getFreshnessInfo(decayedTotalWeight, totalCount) : null;

  return (
    <div className="space-y-4">
      {/* Aggregate stats */}
      {totalCount > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 text-center">
              <p className="text-xs text-muted-foreground mb-0.5">Helpful Rate <span className="text-[9px] opacity-60">(raw)</span></p>
              <p className={`text-xl font-bold ${helpfulRate >= 0.7 ? "text-emerald-400" : helpfulRate >= 0.4 ? "text-amber-400" : "text-red-400"}`}>
                {Math.round(helpfulRate * 100)}%
              </p>
            </div>
            <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 text-center">
              <p className="text-xs text-muted-foreground mb-0.5">Helpful</p>
              <p className="text-xl font-bold text-emerald-400 flex items-center justify-center gap-1">
                <ThumbsUp className="w-4 h-4" /> {helpfulCount}
              </p>
            </div>
            <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 text-center">
              <p className="text-xs text-muted-foreground mb-0.5">Not Helpful</p>
              <p className="text-xl font-bold text-red-400 flex items-center justify-center gap-1">
                <ThumbsDown className="w-4 h-4" /> {unhelpfulCount}
              </p>
            </div>
          </div>
          {/* Freshness / recency indicator */}
          {freshnessInfo && (
            <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
              freshnessInfo.icon === "fresh"
                ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                : freshnessInfo.icon === "aging"
                  ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
                  : "bg-orange-500/5 border-orange-500/20 text-orange-400"
            }`}>
              <span className="shrink-0 mt-0.5">
                {freshnessInfo.icon === "stale" ? "⚠" : "🕐"}
              </span>
              <div className="min-w-0">
                <span className="font-medium capitalize">{freshnessInfo.icon === "fresh" ? "Fresh signal" : freshnessInfo.icon === "aging" ? "Aging signal" : "Stale signal"}</span>
                <span className="text-muted-foreground ml-1">—</span>
                <span className="ml-1">{freshnessInfo.tip}</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-border/40 bg-secondary/20 p-4 text-center text-muted-foreground text-xs">
          <MessageSquare className="w-6 h-6 mx-auto mb-2 opacity-30" />
          No feedback recorded yet. Feedback is collected during and after coding sessions.
        </div>
      )}

      {/* History list */}
      {allHistory.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Events — Showing {allHistory.length} of {totalCount}
          </p>
          <div className="space-y-1">
            {allHistory.map(entry => (
              <div
                key={entry.id}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border/30 bg-secondary/10 text-xs"
              >
                {entry.helpful ? (
                  <ThumbsUp className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <ThumbsDown className="w-3.5 h-3.5 text-red-400 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-muted-foreground">Session </span>
                  <span className="font-mono text-primary/80">#{entry.sessionId}</span>
                  {entry.notes && (
                    <span className="text-muted-foreground ml-2 truncate italic">— {entry.notes}</span>
                  )}
                  {entry.taskSuccessScore != null && (
                    <Badge variant="outline" className="ml-2 text-[9px] py-0 h-4">
                      Score {entry.taskSuccessScore}/5
                    </Badge>
                  )}
                  {entry.tokenDelta != null && entry.tokenDelta !== 0 && (
                    <Badge variant="outline" className={`ml-1 text-[9px] py-0 h-4 ${entry.tokenDelta > 0 ? "text-emerald-400 border-emerald-500/30" : "text-red-400 border-red-500/30"}`}>
                      {entry.tokenDelta > 0 ? "+" : ""}{entry.tokenDelta} tok
                    </Badge>
                  )}
                </div>
                <span className="text-muted-foreground/60 text-[10px] shrink-0">
                  {new Date(entry.createdAt).toLocaleDateString()}
                </span>
                <button
                  className="text-muted-foreground/40 hover:text-red-400 transition-colors shrink-0"
                  onClick={() => handleDelete(entry)}
                  disabled={deleteMutation.isPending}
                  title="Remove this feedback entry"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="pt-1">
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={handleLoadMore}
                disabled={isFetching}
              >
                {isFetching ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1.5" /> Loading…</>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Clear all feedback */}
      {totalCount > 0 && (
        <div className="border-t border-border/30 pt-3">
          {!showClearConfirm ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
              onClick={() => setShowClearConfirm(true)}
            >
              <Trash2 className="w-3 h-3 mr-1.5" />
              Clear all feedback
            </Button>
          ) : (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-2">
              <p className="text-xs text-red-300 text-center">
                Delete all {totalCount} feedback {totalCount === 1 ? "entry" : "entries"} for this skill? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 h-7 text-xs"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={clearAllMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-7 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-600/30"
                  variant="outline"
                  onClick={handleClearAll}
                  disabled={clearAllMutation.isPending}
                >
                  {clearAllMutation.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  ) : (
                    <Trash2 className="w-3 h-3 mr-1.5" />
                  )}
                  Confirm clear all
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkillDetailSheet({
  skill,
  onClose,
  feedbackScores,
  onToggle,
  isActioning,
}: {
  skill: SkillRecord | null;
  onClose: () => void;
  feedbackScores?: Record<string, FeedbackScoreEntry>;
  onToggle?: () => void;
  isActioning?: boolean;
}) {
  if (!skill) return null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-[480px] sm:w-[540px] overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            {skill.name}
          </SheetTitle>
          <div className="flex flex-wrap gap-1.5 mt-1">
            <SkillClassBadge skillClass={skill.class} />
            <TrustBadge trustTier={skill.trustTier} />
            <InstallRiskBadge installRisk={skill.installRisk} />
            {skill.tokenOverheadEstimate != null && (
              <TokenCostBadge tokens={skill.tokenOverheadEstimate} />
            )}
            {feedbackScores && (
              <SkillEffectivenessBadge slug={skill.slug} feedbackScores={feedbackScores} />
            )}
            {feedbackScores?.[skill.slug] && (
              <FreshnessBadge
                decayedTotalWeight={feedbackScores[skill.slug].decayedTotalWeight}
                totalCount={feedbackScores[skill.slug].totalCount}
              />
            )}
          </div>
          {skill.description && (
            <p className="text-sm text-muted-foreground mt-1">{skill.description}</p>
          )}
        </SheetHeader>

        <div className="space-y-6">
          {/* Toggle action */}
          {onToggle && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Status: <span className={skill.enabled ? "text-emerald-400" : "text-muted-foreground"}>{skill.enabled ? "Enabled" : "Disabled"}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={onToggle}
                disabled={isActioning}
              >
                {isActioning ? <Loader2 className="w-3 h-3 animate-spin" /> : (skill.enabled ? "Disable" : "Enable")}
              </Button>
            </div>
          )}

          {/* Provenance */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Provenance
            </p>
            <SkillSourceBlock skillId={skill.id} alwaysOpen />
          </div>

          {/* Design categories */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Palette className="w-3 h-3" />
              Design Categories
            </p>
            <SkillDesignCategoriesPanel skillId={skill.id} />
          </div>

          {/* Feedback history */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Feedback History
            </p>
            <FeedbackHistoryPanel skillId={skill.id} feedbackScore={feedbackScores?.[skill.slug]} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BundleSheet({
  bundle,
  onClose,
}: {
  bundle: SkillBundle | null;
  onClose: () => void;
}) {
  const { data: compiled, isLoading } = useQuery({
    queryKey: ["compile-bundle", bundle?.id, bundle?.taskMode, bundle?.tokenMode],
    enabled: !!bundle,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/skill-bundles/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleId: bundle!.id,
          taskMode: bundle!.taskMode ?? "build",
          tokenMode: bundle!.tokenMode ?? "core",
        }),
      });
      if (!res.ok) throw new Error("Compile failed");
      return res.json() as Promise<{ skills: CompiledSkill[] }>;
    },
  });

  if (!bundle) return null;
  const skills: CompiledSkill[] = compiled?.skills ?? [];

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-[480px] sm:w-[540px] overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" />
            {bundle.name}
          </SheetTitle>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {bundle.isDefault && (
              <Badge variant="outline" className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                MIZI Native
              </Badge>
            )}
            {bundle.taskMode && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground capitalize">
                Task: {bundle.taskMode}
              </Badge>
            )}
            {bundle.sessionMode && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground capitalize">
                Session: {bundle.sessionMode}
              </Badge>
            )}
            {bundle.tokenMode && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground capitalize">
                Tokens: {bundle.tokenMode}
              </Badge>
            )}
            {bundle.modelFamily && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Model: {bundle.modelFamily}
              </Badge>
            )}
            {bundle.repoKind && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground capitalize">
                Repo: {bundle.repoKind}
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {isLoading ? "…" : skills.length} skills
            </Badge>
          </div>
        </SheetHeader>
        <div className="space-y-2">
          {isLoading ? (
            [1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)
          ) : skills.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No skills compiled for this bundle.</p>
          ) : skills.map((skill, i) => (
            <BundleSkillAccordion key={skill.id ?? i} skill={skill} index={i} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ImportModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [url, setUrl] = useState("");
  const { toast } = useToast();
  const importSkill = useImportSkill();

  const handleSubmit = () => {
    if (!url.trim()) return;
    importSkill.mutate({ data: { url: url.trim() } }, {
      onSuccess: (result) => {
        toast({ title: `Imported ${result.count} skill${result.count !== 1 ? "s" : ""} — pending review` });
        setTimeout(() => onSuccess(), 1800);
      },
      onError: (err: Error) => {
        toast({ title: "Import failed", description: err.message || "Check the URL and try again.", variant: "destructive" });
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Skill from GitHub</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Paste a GitHub repository URL containing a <code className="bg-secondary px-1 rounded text-xs">mizi-skills.json</code> manifest.
          </p>
          <Input
            placeholder="https://github.com/org/repo"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            disabled={importSkill.isPending}
            className="font-mono text-sm"
          />
          {importSkill.isSuccess && (
            <div className="flex flex-col gap-1 text-sm text-emerald-400">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0" />
                Imported {importSkill.data?.count} skill{importSkill.data?.count !== 1 ? "s" : ""} — now in Pending Review.
              </div>
              <p className="text-xs text-muted-foreground pl-6">
                From: <span className="font-mono text-primary/80">{url.replace("https://github.com/", "")}</span>
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importSkill.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={importSkill.isPending || !url.trim()}>
            {importSkill.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SkillsLibrary() {
  const [tab, setTab] = useState<LibTab>("installed");
  const [importOpen, setImportOpen] = useState(false);
  const [selectedBundle, setSelectedBundle] = useState<SkillBundle | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [actioningId, setActioningId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const approvedParams = { reviewStatus: "approved" as const };
  const pendingParams = { reviewStatus: "pending" as const };
  const { data: approvedData, isLoading: approvedLoading } = useListSkills(approvedParams, {
    query: { queryKey: getListSkillsQueryKey(approvedParams) },
  });
  const { data: pendingData, isLoading: pendingLoading } = useListSkills(pendingParams, {
    query: { queryKey: getListSkillsQueryKey(pendingParams) },
  });
  const skillsLoading = tab === "pending" ? pendingLoading : approvedLoading;
  const { data: bundlesData, isLoading: bundlesLoading } = useListSkillBundles();
  const { data: feedbackScoresData } = useGetSkillFeedbackScores();
  const reviewSkill = useReviewSkill();
  const enableSkill = useEnableSkill();
  const disableSkill = useDisableSkill();

  const feedbackScoresMap: Record<string, { helpfulRate: number; totalCount: number; decayedTotalWeight: number; decayedHelpfulWeight: number }> = {};
  for (const s of feedbackScoresData?.scores ?? []) {
    feedbackScoresMap[s.slug] = {
      helpfulRate: s.helpfulRate,
      totalCount: s.totalCount,
      decayedTotalWeight: s.decayedTotalWeight ?? s.totalCount,
      decayedHelpfulWeight: s.decayedHelpfulWeight ?? s.helpfulCount,
    };
  }

  const invalidateSkills = () => {
    queryClient.invalidateQueries({ queryKey: getListSkillsQueryKey() });
  };

  const { data: designSyncData } = useQuery({
    queryKey: ["design-intelligence-sources"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/sources`);
      if (!res.ok) throw new Error("Failed to fetch sync status");
      return res.json() as Promise<{
        sources: unknown[];
        sync: {
          lastSyncedAt: string | null;
          lastSyncReason: "sha_change" | "safety_net" | "manual" | null;
          isRunning: boolean;
        };
      }>;
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const { data: skillMapData } = useQuery({
    queryKey: ["design-intelligence-skill-map"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/skill-map`);
      if (!res.ok) throw new Error("Failed to fetch skill map");
      return res.json() as Promise<{ skillMap: Record<string, Array<{ id: number }>>; totalCategories: number }>;
    },
    staleTime: 120000,
  });

  const skillDesignCategoriesById = (() => {
    const map: Record<number, string[]> = {};
    if (!skillMapData?.skillMap) return map;
    for (const [category, skills] of Object.entries(skillMapData.skillMap)) {
      for (const s of skills) {
        if (!map[s.id]) map[s.id] = [];
        map[s.id].push(category);
      }
    }
    return map;
  })();

  function formatRelativeTime(isoString: string | null): string {
    if (!isoString) return "Never";
    const diff = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const syncStatus = designSyncData?.sync;
  const syncReasonLabel =
    syncStatus?.lastSyncReason === "sha_change"
      ? "new commit detected"
      : syncStatus?.lastSyncReason === "safety_net"
      ? "6-hour safety net"
      : syncStatus?.lastSyncReason === "manual"
      ? "manual"
      : null;

  const allApproved = approvedData?.skills ?? [];
  const installedSkills = allApproved.filter(s => s.enabled);
  const disabledSkills = allApproved.filter(s => !s.enabled);
  const pendingSkills = pendingData?.skills ?? [];

  const displayedSkills =
    tab === "installed" ? installedSkills :
    tab === "pending" ? pendingSkills :
    tab === "disabled" ? disabledSkills :
    [];

  const bundles = bundlesData?.bundles ?? [];
  const isDefaultBundle = (b: SkillBundle) => b.isDefault || FALLBACK_DEFAULT_SLUGS.includes(b.slug);
  const defaultBundles = bundles.filter(isDefaultBundle);
  const customBundles = bundles.filter(b => !isDefaultBundle(b));

  const handleApprove = (skill: SkillRecord) => {
    setActioningId(skill.id);
    reviewSkill.mutate({ skillId: skill.id, data: { approved: true } }, {
      onSuccess: () => {
        toast({ title: `"${skill.name}" approved and enabled` });
        invalidateSkills();
        setActioningId(null);
      },
      onError: () => { toast({ title: "Review failed", variant: "destructive" }); setActioningId(null); },
    });
  };

  const handleReject = (skill: SkillRecord) => {
    setActioningId(skill.id);
    reviewSkill.mutate({ skillId: skill.id, data: { approved: false } }, {
      onSuccess: () => {
        toast({ title: `"${skill.name}" rejected` });
        invalidateSkills();
        setActioningId(null);
      },
      onError: () => { toast({ title: "Review failed", variant: "destructive" }); setActioningId(null); },
    });
  };

  const handleToggle = (skill: SkillRecord) => {
    setActioningId(skill.id);
    const mutate = skill.enabled ? disableSkill.mutate : enableSkill.mutate;
    mutate({ skillId: skill.id }, {
      onSuccess: () => {
        toast({ title: `"${skill.name}" ${skill.enabled ? "disabled" : "enabled"}` });
        invalidateSkills();
        setActioningId(null);
      },
      onError: () => { toast({ title: "Failed", variant: "destructive" }); setActioningId(null); },
    });
  };

  const tabs: { id: LibTab; label: string; count?: number }[] = [
    { id: "installed", label: "Installed", count: installedSkills.length },
    { id: "pending", label: "Pending Review", count: pendingSkills.length },
    { id: "disabled", label: "Disabled", count: disabledSkills.length },
    { id: "bundles", label: "Bundles", count: bundles.length },
  ];

  const isLoading = tab === "bundles" ? bundlesLoading : skillsLoading;

  const groupByClass = (skills: SkillRecord[]) => {
    const groups: Record<string, SkillRecord[]> = {};
    for (const s of skills) {
      if (!groups[s.class]) groups[s.class] = [];
      groups[s.class].push(s);
    }
    return groups;
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Wand2 className="w-7 h-7 text-primary" />
            Skills Library
          </h1>
          <p className="text-muted-foreground mt-1">Manage Smart Skills and bundles for AI-assisted coding sessions</p>
          {syncStatus && (
            <p className="text-xs text-muted-foreground/70 mt-1 flex items-center gap-1.5">
              <Clock className="w-3 h-3 shrink-0" />
              {syncStatus.isRunning ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Design data syncing…</span>
                </>
              ) : (
                <>
                  <span>Design data last updated{" "}
                    <span className="text-foreground/60">{formatRelativeTime(syncStatus.lastSyncedAt)}</span>
                  </span>
                  {syncReasonLabel && (
                    <span className="text-foreground/40">({syncReasonLabel})</span>
                  )}
                </>
              )}
            </p>
          )}
        </div>
        <Button className="gap-2" onClick={() => setImportOpen(true)}>
          <Plus className="w-4 h-4" /> Import Skill
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/50">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className={`min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full text-[10px] font-semibold leading-none ${
                tab === t.id ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Installed & Disabled tabs */}
      {(tab === "installed" || tab === "disabled") && (
        <>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 w-full" />)}
            </div>
          ) : displayedSkills.length === 0 ? (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-12 text-center text-muted-foreground">
                <Wand2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p>{tab === "installed" ? "No installed skills yet." : "No disabled skills."}</p>
                {tab === "installed" && (
                  <p className="text-xs mt-1 opacity-70">Import skills from GitHub and approve them to get started.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {Object.entries(groupByClass(displayedSkills)).map(([cls, skills]) => (
                <div key={cls}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                    <SkillClassBadge skillClass={cls} /> {cls}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {skills.map(skill => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        showActions="toggle"
                        onToggle={() => handleToggle(skill)}
                        isActioning={actioningId === skill.id}
                        feedbackScores={feedbackScoresMap}
                        designCategories={skillDesignCategoriesById[skill.id]}
                        onClick={() => setSelectedSkill(skill)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Pending Review tab */}
      {tab === "pending" && (
        <>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2].map(i => <Skeleton key={i} className="h-48 w-full" />)}
            </div>
          ) : pendingSkills.length === 0 ? (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-12 text-center text-muted-foreground">
                <CheckCircle className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p>No skills pending review.</p>
                <p className="text-xs mt-1 opacity-70">Skills imported from GitHub appear here for approval.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {pendingSkills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  showProvenance
                  showActions="review"
                  onApprove={() => handleApprove(skill)}
                  onReject={() => handleReject(skill)}
                  isActioning={actioningId === skill.id}
                  feedbackScores={feedbackScoresMap}
                  designCategories={skillDesignCategoriesById[skill.id]}
                  onClick={() => setSelectedSkill(skill)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Bundles tab */}
      {tab === "bundles" && (
        <>
          {bundlesLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-36 w-full" />)}
            </div>
          ) : (
            <div className="space-y-6">
              {defaultBundles.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                      MIZI Native
                    </Badge>
                    Default Bundles
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {defaultBundles.map(bundle => (
                      <BundleCard key={bundle.id} bundle={bundle} onClick={() => setSelectedBundle(bundle)} />
                    ))}
                  </div>
                </div>
              )}
              {customBundles.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Custom Bundles
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {customBundles.map(bundle => (
                      <BundleCard key={bundle.id} bundle={bundle} onClick={() => setSelectedBundle(bundle)} />
                    ))}
                  </div>
                </div>
              )}
              {bundles.length === 0 && (
                <Card className="bg-card/50 border-border/50">
                  <CardContent className="py-12 text-center text-muted-foreground">
                    <Package className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    <p>No bundles yet. Default bundles will be seeded automatically.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onSuccess={() => {
            setImportOpen(false);
            setTab("pending");
            invalidateSkills();
          }}
        />
      )}

      {selectedBundle && (
        <BundleSheet bundle={selectedBundle} onClose={() => setSelectedBundle(null)} />
      )}

      {selectedSkill && (
        <SkillDetailSheet
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          feedbackScores={feedbackScoresMap}
          onToggle={selectedSkill.reviewStatus === "approved" ? () => {
            handleToggle(selectedSkill);
            setSelectedSkill(prev => prev ? { ...prev, enabled: !prev.enabled } : null);
          } : undefined}
          isActioning={actioningId === selectedSkill.id}
        />
      )}
    </div>
  );
}

function BundleCard({ bundle, onClick }: { bundle: SkillBundle; onClick: () => void }) {
  const { data: compiled } = useQuery({
    queryKey: ["compile-bundle-card", bundle.id, bundle.taskMode, bundle.tokenMode],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/skill-bundles/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleId: bundle.id,
          taskMode: bundle.taskMode ?? "build",
          tokenMode: bundle.tokenMode ?? "core",
        }),
      });
      if (!res.ok) throw new Error("Compile failed");
      return res.json() as Promise<{ skills: CompiledSkill[] }>;
    },
  });

  const skills = compiled?.skills ?? [];

  return (
    <Card
      className="bg-card/50 border-border/50 hover:border-primary/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 mb-1 flex-wrap">
              {bundle.isDefault && (
                <Badge variant="outline" className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30 py-0">
                  Native
                </Badge>
              )}
              {bundle.taskMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 capitalize">{bundle.taskMode}</Badge>
              )}
              {bundle.sessionMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 capitalize">{bundle.sessionMode}</Badge>
              )}
              {bundle.tokenMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 capitalize">{bundle.tokenMode}</Badge>
              )}
              {bundle.modelFamily && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0">{bundle.modelFamily}</Badge>
              )}
            </div>
            <h3 className="font-semibold text-sm">{bundle.name}</h3>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{bundle.slug}</p>
          </div>
          <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">
            {skills.length > 0 ? `${skills.length} skills` : "…"}
          </Badge>
        </div>
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skills.map((s, i) => (
              s.class && <SkillClassBadge key={s.id ?? i} skillClass={s.class} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
