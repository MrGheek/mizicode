import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Palette, Search, Tag, Loader2, AlertCircle, RefreshCw, Clock, CheckCircle2, XCircle, Wand2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const PAGE_SIZE = 20;

type SkillSummary = {
  id: number;
  slug: string;
  name: string;
  class: string;
  enabled: boolean;
};

type SkillMapResponse = {
  skillMap: Record<string, SkillSummary[]>;
  totalCategories: number;
};

type DesignEntry = {
  id: number;
  category: string;
  name: string;
  data_json: Record<string, unknown>;
  tags: string[];
};

type EntriesPage = {
  entries: DesignEntry[];
  total: number;
  limit: number;
  offset: number;
};

type CategoryInfo = {
  category: string;
  count: number;
};

type SyncStatus = {
  lastSyncedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  intervalMs: number;
  isRunning: boolean;
};

type SourcesResponse = {
  sources: unknown[];
  sync: SyncStatus;
};

function useDesignSources() {
  return useQuery<SourcesResponse>({
    queryKey: ["design-intelligence-sources"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/sources`);
      if (!res.ok) throw new Error("Failed to fetch sync status");
      return res.json() as Promise<SourcesResponse>;
    },
    staleTime: 30000,
    refetchInterval: 30000,
  });
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCountdown(isoString: string | null): string {
  if (!isoString) return "—";
  const diff = new Date(isoString).getTime() - Date.now();
  if (diff <= 0) return "Soon";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins === 0) return `${hours}h`;
  return `${hours}h ${remainingMins}m`;
}

function formatAbsoluteTime(isoString: string | null): string {
  if (!isoString) return "";
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function SyncStatusBar({ sync, onSyncNow, isSyncing, syncAlreadyRunning }: {
  sync: SyncStatus;
  onSyncNow: () => void;
  isSyncing: boolean;
  syncAlreadyRunning: boolean;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const hasError = !!sync.lastError;
  const isActive = sync.isRunning || isSyncing;

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs ${
      hasError
        ? "border-destructive/30 bg-destructive/5"
        : isActive
        ? "border-primary/30 bg-primary/5"
        : "border-border/50 bg-muted/30"
    }`}>
      <div className="flex items-center gap-1.5 shrink-0">
        {isActive ? (
          <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
        ) : hasError ? (
          <XCircle className="w-3.5 h-3.5 text-destructive" />
        ) : sync.lastSyncedAt ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <span className={`font-medium ${
          hasError ? "text-destructive" : isActive ? "text-primary" : "text-foreground/80"
        }`}>
          {isActive ? "Syncing…" : hasError ? "Sync failed" : "Synced"}
        </span>
      </div>

      <div className="flex items-center gap-3 text-muted-foreground flex-1 flex-wrap">
        <span
          title={formatAbsoluteTime(sync.lastSyncedAt)}
          className="cursor-default"
        >
          Last synced:{" "}
          <span className="text-foreground/70">
            {formatRelativeTime(sync.lastSyncedAt)}
          </span>
        </span>
        {sync.nextSyncAt && !isActive && (
          <span
            title={`Scheduled for ${formatAbsoluteTime(sync.nextSyncAt)}`}
            className="cursor-default"
          >
            Next sync in:{" "}
            <span className="text-foreground/70">{formatCountdown(sync.nextSyncAt)}</span>
          </span>
        )}
        {syncAlreadyRunning && !isActive && (
          <span className="text-amber-500/80">Sync already in progress</span>
        )}
        {hasError && (
          <span className="text-destructive/80 truncate max-w-xs" title={sync.lastError ?? ""}>
            {sync.lastError}
          </span>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px] shrink-0"
        onClick={onSyncNow}
        disabled={isActive}
        title="Trigger an on-demand sync now"
      >
        <RefreshCw className={`w-3 h-3 mr-1 ${isActive ? "animate-spin" : ""}`} />
        Sync now
      </Button>
    </div>
  );
}

function useDesignSkillMap() {
  return useQuery<SkillMapResponse>({
    queryKey: ["design-intelligence-skill-map"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/skill-map`);
      if (!res.ok) throw new Error("Failed to fetch skill map");
      return res.json() as Promise<SkillMapResponse>;
    },
    staleTime: 120000,
  });
}

function useDesignCategories() {
  return useQuery<CategoryInfo[]>({
    queryKey: ["design-intelligence-categories"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/categories`);
      if (!res.ok) throw new Error("Failed to fetch categories");
      const data = await res.json();
      return data.categories as CategoryInfo[];
    },
    staleTime: 60000,
  });
}

function useDesignEntriesPage(
  category: string | undefined,
  q: string,
  offset: number,
) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (q.trim()) params.set("q", q.trim());
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  return useQuery<EntriesPage>({
    queryKey: ["design-intelligence-entries", category, q, offset],
    queryFn: async () => {
      const res = await fetch(
        `${BASE_URL}api/design-intelligence?${params.toString()}`,
      );
      if (!res.ok) throw new Error("Failed to fetch entries");
      return res.json() as Promise<EntriesPage>;
    },
    staleTime: 30000,
  });
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const CSS_NAMED_COLORS = new Set([
  "aliceblue","antiquewhite","aqua","aquamarine","azure","beige","bisque","black",
  "blanchedalmond","blue","blueviolet","brown","burlywood","cadetblue","chartreuse",
  "chocolate","coral","cornflowerblue","cornsilk","crimson","cyan","darkblue",
  "darkcyan","darkgoldenrod","darkgray","darkgreen","darkgrey","darkkhaki",
  "darkmagenta","darkolivegreen","darkorange","darkorchid","darkred","darksalmon",
  "darkseagreen","darkslateblue","darkslategray","darkslategrey","darkturquoise",
  "darkviolet","deeppink","deepskyblue","dimgray","dimgrey","dodgerblue","firebrick",
  "floralwhite","forestgreen","fuchsia","gainsboro","ghostwhite","gold","goldenrod",
  "gray","green","greenyellow","grey","honeydew","hotpink","indianred","indigo",
  "ivory","khaki","lavender","lavenderblush","lawngreen","lemonchiffon","lightblue",
  "lightcoral","lightcyan","lightgoldenrodyellow","lightgray","lightgreen","lightgrey",
  "lightpink","lightsalmon","lightseagreen","lightskyblue","lightslategray",
  "lightslategrey","lightsteelblue","lightyellow","lime","limegreen","linen","magenta",
  "maroon","mediumaquamarine","mediumblue","mediumorchid","mediumpurple","mediumseagreen",
  "mediumslateblue","mediumspringgreen","mediumturquoise","mediumvioletred","midnightblue",
  "mintcream","mistyrose","moccasin","navajowhite","navy","oldlace","olive","olivedrab",
  "orange","orangered","orchid","palegoldenrod","palegreen","paleturquoise","palevioletred",
  "papayawhip","peachpuff","peru","pink","plum","powderblue","purple","red","rosybrown",
  "royalblue","saddlebrown","salmon","sandybrown","seagreen","seashell","sienna","silver",
  "skyblue","slateblue","slategray","slategrey","snow","springgreen","steelblue","tan",
  "teal","thistle","tomato","turquoise","violet","wheat","white","whitesmoke","yellow",
  "yellowgreen",
]);

function parseColorValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (HEX_RE.test(trimmed)) return trimmed;
  if (CSS_NAMED_COLORS.has(trimmed.toLowerCase())) return trimmed;
  return null;
}

const COLOR_KEYS = ["value", "color", "hex", "background", "foreground", "fill", "stroke", "primary", "secondary", "accent", "base", "light", "dark", "shade", "tint"];

function extractEntryColor(data: Record<string, unknown>): string | null {
  for (const key of COLOR_KEYS) {
    const color = parseColorValue(data[key]);
    if (color) return color;
  }
  for (const key of Object.keys(data)) {
    const color = parseColorValue(data[key]);
    if (color) return color;
  }
  return null;
}

function isColorCategory(category: string): boolean {
  const lower = category.toLowerCase();
  return lower.includes("color") || lower.includes("palette") || lower.includes("style");
}

function ColorSwatch({ color, size = "md" }: { color: string; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-3 h-3" : "w-4 h-4";
  return (
    <span
      className={`inline-block ${dim} rounded-sm border border-black/10 shrink-0`}
      style={{ backgroundColor: color }}
      title={color}
    />
  );
}

function DataJsonView({ data }: { data: Record<string, unknown> }) {
  const keys = Object.keys(data);
  const previewKeys = keys.slice(0, 4);
  const [showAll, setShowAll] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {previewKeys.map((k) => {
          const v = data[k];
          const colorValue = parseColorValue(v);
          const display =
            typeof v === "string"
              ? v.length > 60
                ? v.slice(0, 60) + "…"
                : v
              : typeof v === "number" || typeof v === "boolean"
              ? String(v)
              : Array.isArray(v)
              ? `[${(v as unknown[]).length} items]`
              : typeof v === "object" && v !== null
              ? "{…}"
              : String(v ?? "");
          return (
            <span key={k} className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="text-foreground/60 font-medium">{k}:</span>{" "}
              {colorValue && <ColorSwatch color={colorValue} size="sm" />}
              <span>{display}</span>
            </span>
          );
        })}
      </div>
      {keys.length > 4 && (
        <button
          className="text-[10px] text-primary/70 hover:text-primary underline underline-offset-2"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Hide full data" : `Show all ${keys.length} fields`}
        </button>
      )}
      {showAll && (
        <pre className="mt-1.5 bg-secondary/40 rounded p-2 overflow-x-auto text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

const SKILL_CLASS_COLORS: Record<string, string> = {
  design: "text-purple-400 border-purple-500/30",
  ui: "text-indigo-400 border-indigo-500/30",
  frontend: "text-sky-400 border-sky-500/30",
  backend: "text-emerald-400 border-emerald-500/30",
  devops: "text-amber-400 border-amber-500/30",
};

function RelatedSkillsBadges({ skills }: { skills: SkillSummary[] }) {
  if (skills.length === 0) return null;
  const shown = skills.slice(0, 3);
  const extra = skills.length - shown.length;

  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-2 pt-2 border-t border-border/30">
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
        <Wand2 className="w-2.5 h-2.5" />
        Skills:
      </span>
      {shown.map((s) => (
        <Badge
          key={s.id}
          variant="outline"
          className={`text-[10px] py-0 h-4 gap-1 ${SKILL_CLASS_COLORS[s.class] ?? "text-muted-foreground border-border/50"}`}
          title={`${s.name} (${s.class})`}
        >
          {s.enabled ? null : <span className="opacity-50">○</span>}
          {s.name}
        </Badge>
      ))}
      {extra > 0 && (
        <span className="text-[10px] text-muted-foreground">+{extra} more</span>
      )}
    </div>
  );
}

function EntryCard({ entry, relatedSkills }: { entry: DesignEntry; relatedSkills?: SkillSummary[] }) {
  const swatchColor =
    isColorCategory(entry.category) ? extractEntryColor(entry.data_json) : null;
  return (
    <Card className="bg-card/50 border-border/50">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2 flex-wrap mb-1.5">
          <Badge
            variant="outline"
            className="text-[10px] py-0 h-4 border-primary/30 text-primary/80"
          >
            {entry.category}
          </Badge>
          {entry.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] py-0 h-4">
              {tag}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-1.5">
          {swatchColor && <ColorSwatch color={swatchColor} />}
          <p className="font-semibold text-sm">{entry.name}</p>
        </div>
        <DataJsonView data={entry.data_json} />
        {relatedSkills && relatedSkills.length > 0 && (
          <RelatedSkillsBadges skills={relatedSkills} />
        )}
      </CardContent>
    </Card>
  );
}

const CATEGORY_ICONS: Record<string, string> = {
  colors: "🎨",
  typography: "Aa",
  charts: "📊",
  "ui-patterns": "⬜",
  fonts: "T",
  icons: "✦",
  palette: "🎨",
  style: "◈",
};

function categoryIcon(cat: string) {
  const key = Object.keys(CATEGORY_ICONS).find((k) =>
    cat.toLowerCase().includes(k),
  );
  return key ? CATEGORY_ICONS[key] : "◆";
}

export default function DesignIntelligence() {
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [accumulatedEntries, setAccumulatedEntries] = useState<DesignEntry[]>([]);

  const queryClient = useQueryClient();

  const { data: categories, isLoading: catsLoading, isError: catsError } =
    useDesignCategories();

  const { data: page, isLoading: pageLoading, isError: pageError } =
    useDesignEntriesPage(selectedCategory, search, offset);

  const { data: sourcesData } = useDesignSources();
  const { data: skillMapData } = useDesignSkillMap();

  const [syncAlreadyRunning, setSyncAlreadyRunning] = useState(false);

  const ALREADY_RUNNING_MSG = "__sync_already_running__";

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE_URL}api/design-intelligence/sync`, { method: "POST" });
      const body = await res.json() as { ok?: boolean; error?: string; message?: string };
      if (res.status === 409) {
        setSyncAlreadyRunning(true);
        setTimeout(() => setSyncAlreadyRunning(false), 5000);
        throw new Error(ALREADY_RUNNING_MSG);
      }
      if (!res.ok) {
        throw new Error(body.error ?? "Sync failed");
      }
      setSyncAlreadyRunning(false);
      return body;
    },
    onSuccess: () => {
      toast({ title: "Sync complete", description: "Design intelligence sources are up to date." });
      void queryClient.invalidateQueries({ queryKey: ["design-intelligence-sources"] });
    },
    onError: (err: Error) => {
      if (err.message === ALREADY_RUNNING_MSG) return;
      toast({
        title: "Sync failed",
        description: err.message,
        variant: "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: ["design-intelligence-sources"] });
    },
  });

  useEffect(() => {
    if (!page) return;
    if (offset === 0) {
      setAccumulatedEntries(page.entries);
    } else {
      setAccumulatedEntries((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const newEntries = page.entries.filter((e) => !existingIds.has(e.id));
        return [...prev, ...newEntries];
      });
    }
  }, [page, offset]);

  const handleFilterChange = (cat: string | undefined) => {
    setSelectedCategory(cat);
    setOffset(0);
    setAccumulatedEntries([]);
  };

  const handleSearchChange = (q: string) => {
    setSearch(q);
    setOffset(0);
    setAccumulatedEntries([]);
  };

  const total = page?.total ?? 0;
  const shown = accumulatedEntries.length;
  const hasMore = shown < total;

  const totalCategoryCount =
    categories?.reduce((s, c) => s + c.count, 0) ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Palette className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Design Intelligence</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalCategoryCount.toLocaleString()} entries across colors, typography, charts, UI patterns, and more
          </p>
        </div>
      </div>

      {/* Sync status */}
      {sourcesData && (
        <SyncStatusBar
          sync={sourcesData.sync}
          onSyncNow={() => syncMutation.mutate()}
          isSyncing={syncMutation.isPending}
          syncAlreadyRunning={syncAlreadyRunning}
        />
      )}

      {/* Category filter */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Category
        </p>
        {catsLoading ? (
          <div className="flex gap-2 flex-wrap">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-7 w-24 rounded-full" />
            ))}
          </div>
        ) : catsError ? (
          <p className="text-xs text-destructive">Failed to load categories</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => handleFilterChange(undefined)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                selectedCategory === undefined
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              All
              <span className="opacity-70">
                ({totalCategoryCount.toLocaleString()})
              </span>
            </button>
            {categories?.map((cat) => (
              <button
                key={cat.category}
                onClick={() => handleFilterChange(cat.category)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selectedCategory === cat.category
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                <span>{categoryIcon(cat.category)}</span>
                <span className="capitalize">{cat.category}</span>
                <span className="opacity-70">({cat.count.toLocaleString()})</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search entries by name or content…"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9 h-9 text-sm"
        />
      </div>

      {/* Results */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Tag className="w-3 h-3" />
            Entries
            {!pageLoading && total > 0 && (
              <span className="text-primary/70">
                (showing {shown.toLocaleString()} of {total.toLocaleString()})
              </span>
            )}
          </p>
        </div>

        {pageLoading && offset === 0 ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : pageError && accumulatedEntries.length === 0 ? (
          <div className="flex items-center gap-2 text-destructive text-sm p-4 rounded-lg border border-destructive/30 bg-destructive/10">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Failed to load entries. Check API connectivity.
          </div>
        ) : accumulatedEntries.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Palette className="w-10 h-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No entries found.</p>
            {search && (
              <p className="text-xs mt-1">
                Try a different search term or clear filters.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {accumulatedEntries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                relatedSkills={skillMapData?.skillMap[entry.category]}
              />
            ))}
            {hasMore && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                  onClick={() => setOffset(shown)}
                  disabled={pageLoading}
                >
                  {pageLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  ) : null}
                  Load more ({(total - shown).toLocaleString()} remaining)
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
