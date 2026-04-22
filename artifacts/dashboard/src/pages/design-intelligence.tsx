import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Palette, Search, Tag, ChevronDown, ChevronRight, Loader2, AlertCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const PAGE_SIZE = 20;

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

function DataJsonView({ data }: { data: Record<string, unknown> }) {
  const keys = Object.keys(data);
  const previewKeys = keys.slice(0, 4);
  const [showAll, setShowAll] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {previewKeys.map((k) => {
          const v = data[k];
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
            <span key={k} className="text-muted-foreground">
              <span className="text-foreground/60 font-medium">{k}:</span>{" "}
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

function EntryCard({ entry }: { entry: DesignEntry }) {
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
        <p className="font-semibold text-sm mb-1.5">{entry.name}</p>
        <DataJsonView data={entry.data_json} />
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

  const { data: categories, isLoading: catsLoading, isError: catsError } =
    useDesignCategories();

  const { data: page, isLoading: pageLoading, isError: pageError } =
    useDesignEntriesPage(selectedCategory, search, offset);

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
              <EntryCard key={entry.id} entry={entry} />
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
