import { useState, useRef, useEffect } from "react";
import {
  useListSkills,
  useImportSkill,
  useReviewSkill,
  useEnableSkill,
  useDisableSkill,
  useListSkillBundles,
} from "@workspace/api-client-react";
import type { SkillRecord, SkillBundle } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Wand2, Plus, ExternalLink, AlertTriangle, ChevronDown, ChevronRight,
  Loader2, CheckCircle, XCircle, Package, Info, GitBranch,
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
  const [expanded, setExpanded] = useState(false);
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
          <div className="rounded border border-border/40 bg-secondary/20 text-xs space-y-1.5 p-2.5">
            {skill.sourceId != null && (
              <div className="flex items-center gap-2">
                <GitBranch className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Source ID:</span>
                <span className="font-mono text-primary/80">{skill.sourceId}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Info className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Slug:</span>
              <span className="font-mono text-primary/80">{skill.slug}</span>
            </div>
            <div className="flex items-center gap-2">
              <Info className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Install risk:</span>
              <InstallRiskBadge installRisk={skill.installRisk} />
            </div>
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mt-1 transition-colors"
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Manifest details
            </button>
            {expanded && (
              <div className="mt-1 border border-border/40 rounded p-2 bg-background/50 font-mono text-[10px] text-muted-foreground break-all">
                id={skill.id} | class={skill.class} | trust={skill.trustTier} | risk={skill.installRisk} | status={skill.reviewStatus}
              </div>
            )}
          </div>
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

function BundleSheet({
  bundle,
  onClose,
}: {
  bundle: SkillBundle | null;
  onClose: () => void;
}) {
  if (!bundle) return null;

  type BundleJsonType = {
    skills?: Array<{
      id?: string | number;
      name?: string;
      class?: string;
      summary?: string;
      instructions?: { system?: string };
    }>;
  };

  const bundleJson = (bundle.bundleJson ?? {}) as BundleJsonType;
  const skills = bundleJson.skills ?? [];

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
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {bundle.taskMode}
              </Badge>
            )}
            {bundle.tokenMode && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {bundle.tokenMode} tokens
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {skills.length} skills
            </Badge>
          </div>
        </SheetHeader>
        <div className="space-y-3">
          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No skills in this bundle.</p>
          ) : skills.map((skill, i) => (
            <div key={skill.id ?? i} className="border border-border/40 rounded-lg">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left"
                onClick={(e) => {
                  const el = e.currentTarget.nextElementSibling as HTMLElement;
                  if (el) el.classList.toggle("hidden");
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {skill.class && <SkillClassBadge skillClass={skill.class} />}
                  <span className="font-medium text-sm truncate">{skill.name ?? skill.id ?? "Skill"}</span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              </button>
              <div className="hidden px-3 pb-3 text-xs text-muted-foreground space-y-2 border-t border-border/40 pt-2">
                {skill.summary && <p>{skill.summary}</p>}
                {skill.instructions?.system && (
                  <div>
                    <p className="font-semibold text-foreground/70 mb-1">Instructions:</p>
                    <ul className="space-y-0.5 list-disc list-inside">
                      {skill.instructions.system.split("\n").filter(Boolean).map((line, j) => (
                        <li key={j}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
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

  const { data: skillsData, isLoading: skillsLoading } = useListSkills({
    params: tab === "pending" ? { reviewStatus: "pending" as const } : { reviewStatus: "approved" as const },
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
  type BundleJsonType = { skills?: Array<{ id?: string | number; class?: string; name?: string }> };
  const bj = (bundle.bundleJson ?? {}) as BundleJsonType;
  const skills = bj.skills ?? [];

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
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0">{bundle.taskMode}</Badge>
              )}
              {bundle.tokenMode && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground py-0">{bundle.tokenMode}</Badge>
              )}
            </div>
            <h3 className="font-semibold text-sm">{bundle.name}</h3>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{bundle.slug}</p>
          </div>
          <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">
            {skills.length} skills
          </Badge>
        </div>
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skills.slice(0, 6).map((s, i) => (
              <span key={s.id ?? i} className="text-[10px]">
                {s.class && <SkillClassBadge skillClass={s.class} />}
              </span>
            ))}
            {skills.length > 6 && (
              <span className="text-[10px] text-muted-foreground">+{skills.length - 6} more</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
