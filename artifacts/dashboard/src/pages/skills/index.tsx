import { useState, useRef, useEffect } from "react";
import {
  useListSkills,
  useImportSkill,
  useReviewSkill,
  useEnableSkill,
  useDisableSkill,
  useListSkillBundles,
  useGetSkill,
  getListSkillsQueryKey,
} from "@workspace/api-client-react";
import type { SkillRecord, SkillBundle } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  Wand2, Plus, ExternalLink, AlertTriangle, ChevronDown, ChevronRight,
  Loader2, CheckCircle, XCircle, Package, GitBranch, Key, Scale,
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
import { SkillClassBadge, TrustBadge, TokenCostBadge, InstallRiskBadge } from "@/components/skill-badges";

type LibTab = "installed" | "pending" | "disabled" | "bundles";

const DEFAULT_BUNDLE_SLUGS = ["floatr-builder", "floatr-reviewer", "floatr-debugger", "floatr-team-studio"];
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
          <span className="flex items-center gap-1.5">
            <GitBranch className="w-3 h-3" />
            Source & Manifest
          </span>
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
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
              {manifest?.instructions && manifest.instructions.length > 0 && (
                <div className="border-t border-border/30 pt-2 mt-1">
                  <p className="text-[10px] font-semibold text-foreground/60 mb-1 uppercase tracking-wide">Manifest Instructions</p>
                  <ul className="space-y-0.5 list-disc list-inside text-muted-foreground">
                    {manifest.instructions.map((line, i) => (
                      <li key={i} className="text-[10px] leading-relaxed">{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {manifest?.triggers && manifest.triggers.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  <span className="text-[10px] text-muted-foreground">Triggers:</span>
                  {manifest.triggers.map(t => (
                    <Badge key={t} variant="outline" className="text-[9px] py-0 h-4">{t}</Badge>
                  ))}
                </div>
              )}
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
}: {
  skill: SkillRecord;
  showProvenance?: boolean;
  showActions?: "review" | "toggle";
  onApprove?: () => void;
  onReject?: () => void;
  onToggle?: () => void;
  isActioning?: boolean;
}) {
  const isHighRisk = skill.installRisk === "hooked" || skill.installRisk === "binary";

  return (
    <Card className="bg-card/50 border-border/50">
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
                onClick={onToggle}
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
                onClick={onApprove}
                disabled={isActioning}
              >
                {isActioning ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <CheckCircle className="w-3 h-3 mr-1.5" />}
                Approve
              </Button>
              <Button
                size="sm"
                className="flex-1 h-8 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-600/30"
                variant="outline"
                onClick={onReject}
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
        </div>
      )}
    </div>
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
            {bundle.tokenMode && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground capitalize">
                Tokens: {bundle.tokenMode}
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
        onSuccess();
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
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle className="w-4 h-4" />
              Imported {importSkill.data?.count} skill(s) — now in Pending Review.
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
  const [actioningId, setActioningId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const pendingParams = tab === "pending" ? { reviewStatus: "pending" as const } : undefined;
  const approvedParams = tab !== "pending" && tab !== "bundles" ? { reviewStatus: "approved" as const } : undefined;
  const activeParams = pendingParams ?? approvedParams;
  const { data: skillsData, isLoading: skillsLoading } = useListSkills(activeParams, {
    query: { enabled: tab !== "bundles", queryKey: getListSkillsQueryKey(activeParams) },
  });
  const { data: bundlesData, isLoading: bundlesLoading } = useListSkillBundles();
  const reviewSkill = useReviewSkill();
  const enableSkill = useEnableSkill();
  const disableSkill = useDisableSkill();

  const invalidateSkills = () => {
    queryClient.invalidateQueries({ queryKey: ["listSkills"] });
  };

  const allApproved = skillsData?.skills ?? [];
  const installedSkills = allApproved.filter(s => s.enabled);
  const disabledSkills = allApproved.filter(s => !s.enabled);
  const pendingSkills = tab === "pending" ? (skillsData?.skills ?? []) : [];

  const displayedSkills =
    tab === "installed" ? installedSkills :
    tab === "pending" ? pendingSkills :
    tab === "disabled" ? disabledSkills :
    [];

  const bundles = bundlesData?.bundles ?? [];
  const defaultBundles = bundles.filter(b => DEFAULT_BUNDLE_SLUGS.includes(b.slug));
  const customBundles = bundles.filter(b => !DEFAULT_BUNDLE_SLUGS.includes(b.slug));

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
    </div>
  );
}

function BundleCard({ bundle, onClick }: { bundle: SkillBundle; onClick: () => void }) {
  type BundleJsonType = { skillIds?: number[] };
  const bj = (bundle.bundleJson ?? {}) as BundleJsonType;
  const skillCount = (bj.skillIds ?? []).length;

  return (
    <Card
      className="bg-card/50 border-border/50 hover:border-primary/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              {bundle.isDefault && (
                <Badge variant="outline" className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30 py-0">
                  Native
                </Badge>
              )}
              {bundle.taskMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 capitalize">Task: {bundle.taskMode}</Badge>
              )}
              {bundle.tokenMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 capitalize">Tokens: {bundle.tokenMode}</Badge>
              )}
            </div>
            <h3 className="font-semibold text-sm">{bundle.name}</h3>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{bundle.slug}</p>
          </div>
          <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">
            click to preview
          </Badge>
        </div>
        {skillCount > 0 && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Package className="w-3 h-3" /> {skillCount} skill{skillCount !== 1 ? "s" : ""} · click to view details
          </p>
        )}
      </CardContent>
    </Card>
  );
}
