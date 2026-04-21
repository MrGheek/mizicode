import { useState } from "react";
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
  getGetSkillFeedbackHistoryQueryKey,
  getGetSkillFeedbackScoresQueryKey,
} from "@workspace/api-client-react";
import type { SkillRecord, SkillBundle, SkillFeedbackHistoryEntry } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  Wand2, Plus, ExternalLink, AlertTriangle, ChevronDown, ChevronRight,
  Loader2, CheckCircle, XCircle, Package, GitBranch, Key, Scale,
  ThumbsUp, ThumbsDown, Trash2, MessageSquare,
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
import { SkillClassBadge, TrustBadge, TokenCostBadge, InstallRiskBadge, SkillEffectivenessBadge } from "@/components/skill-badges";

type LibTab = "installed" | "pending" | "disabled" | "bundles";

const FALLBACK_DEFAULT_SLUGS = ["floatr-builder", "floatr-reviewer", "floatr-debugger", "floatr-team-studio"];
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

function SkillCard({
  skill,
  showProvenance,
  showActions,
  onApprove,
  onReject,
  onToggle,
  isActioning,
  feedbackScores,
  onClick,
}: {
  skill: SkillRecord;
  showProvenance?: boolean;
  showActions?: "review" | "toggle";
  onApprove?: () => void;
  onReject?: () => void;
  onToggle?: () => void;
  isActioning?: boolean;
  feedbackScores?: Record<string, { helpfulRate: number; totalCount: number }>;
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

function FeedbackHistoryPanel({ skillId }: { skillId: number }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useGetSkillFeedbackHistory(skillId);
  const deleteMutation = useDeleteSkillFeedbackEntry();
  const { toast } = useToast();

  const handleDelete = (entry: SkillFeedbackHistoryEntry) => {
    deleteMutation.mutate({ skillId, feedbackId: entry.id }, {
      onSuccess: () => {
        toast({ title: "Feedback entry removed" });
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackHistoryQueryKey(skillId) });
        queryClient.invalidateQueries({ queryKey: getGetSkillFeedbackScoresQueryKey() });
      },
      onError: () => toast({ title: "Failed to remove entry", variant: "destructive" }),
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4">
        Could not load feedback history.
      </p>
    );
  }

  const { helpfulRate, totalCount, helpfulCount, unhelpfulCount, history } = data;

  return (
    <div className="space-y-4">
      {/* Aggregate stats */}
      {totalCount > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-0.5">Helpful Rate</p>
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
      ) : (
        <div className="rounded-lg border border-border/40 bg-secondary/20 p-4 text-center text-muted-foreground text-xs">
          <MessageSquare className="w-6 h-6 mx-auto mb-2 opacity-30" />
          No feedback recorded yet. Feedback is collected during and after coding sessions.
        </div>
      )}

      {/* History list */}
      {history.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Events ({totalCount} total)
          </p>
          <div className="space-y-1">
            {history.map(entry => (
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
  feedbackScores?: Record<string, { helpfulRate: number; totalCount: number }>;
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

          {/* Feedback history */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Feedback History
            </p>
            <FeedbackHistoryPanel skillId={skill.id} />
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
                FLOATR Native
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
            Paste a GitHub repository URL containing a <code className="bg-secondary px-1 rounded text-xs">floatr-skills.json</code> manifest.
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

  const feedbackScoresMap: Record<string, { helpfulRate: number; totalCount: number }> = {};
  for (const s of feedbackScoresData?.scores ?? []) {
    feedbackScoresMap[s.slug] = { helpfulRate: s.helpfulRate, totalCount: s.totalCount };
  }

  const invalidateSkills = () => {
    queryClient.invalidateQueries({ queryKey: getListSkillsQueryKey() });
  };

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
                      FLOATR Native
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
