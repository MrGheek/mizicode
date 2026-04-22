import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Brain, Search, X, Clock, ChevronDown, ChevronRight, FolderOpen, Download, Upload, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const PAGE_SIZE = 30;
const SESSIONS_PAGE_SIZE = 50;

interface MemSession {
  id: string;
  userId: string;
  projectPath: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  observationCount: number;
}

interface MemObservation {
  id: number;
  sessionId: string;
  userId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  recordedAt: number;
}

interface SearchResultObservation extends MemObservation {
  sessionSummary: string | null;
  sessionStartedAt: number;
}

interface MemorySearchResult {
  observations: SearchResultObservation[];
  sessions: MemSession[];
  totalObservations: number;
  totalSessions: number;
}

function useSessionsPage(offset: number) {
  return useQuery<MemSession[]>({
    queryKey: ["mem-all-sessions", offset],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/sessions?limit=${SESSIONS_PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error("Failed to fetch memory sessions");
      return res.json();
    },
    refetchInterval: offset === 0 ? 60000 : false,
  });
}

function useGlobalSearch(query: string, projectPath: string, offset: number) {
  return useQuery<MemorySearchResult>({
    queryKey: ["mem-global-search", query, projectPath, offset],
    enabled: query.trim().length > 1,
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, limit: String(PAGE_SIZE), offset: String(offset) });
      if (projectPath) params.set("projectPath", projectPath);
      const res = await fetch(`${BASE_URL}api/memory/search?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to search memory");
      return res.json();
    },
    staleTime: 5000,
  });
}

function MemoryBackupCard() {
  const [restoring, setRestoring] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`${BASE_URL}api/memory/backup`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `mem-backup-${new Date().toISOString().slice(0, 10)}.db`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Memory backup downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download backup");
    } finally {
      setDownloading(false);
    }
  }

  async function handleRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!e.target.files) return;
    e.target.value = "";
    if (!file) return;
    if (!file.name.endsWith(".db") && !file.name.endsWith(".sqlite") && !file.name.endsWith(".sqlite3")) {
      toast.error("Please select a .db or .sqlite file");
      return;
    }
    setRestoring(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`${BASE_URL}api/memory/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || "Restore failed");
      }
      toast.success("Memory database restored — reload the page to see updated data");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore backup");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
          <Download className="w-4 h-4" /> Backup &amp; Restore
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 space-y-1.5">
            <p className="text-xs font-medium text-foreground">Download backup</p>
            <p className="text-xs text-muted-foreground">
              Export your full memory database as a <code className="font-mono text-[10px] bg-secondary/40 rounded px-1">.db</code> file.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 gap-1.5"
              onClick={handleDownload}
              disabled={downloading}
            >
              <Download className="w-3.5 h-3.5" />
              {downloading ? "Downloading…" : "Download .db"}
            </Button>
          </div>

          <div className="w-px bg-border/40 hidden sm:block" />

          <div className="flex-1 space-y-1.5">
            <p className="text-xs font-medium text-foreground">Restore from backup</p>
            <p className="text-xs text-muted-foreground">
              Upload a previously downloaded <code className="font-mono text-[10px] bg-secondary/40 rounded px-1">.db</code> file to replace the current database.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
                disabled={restoring}
              >
                <Upload className="w-3.5 h-3.5" />
                {restoring ? "Restoring…" : "Upload & Restore"}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3"
              className="hidden"
              onChange={handleRestore}
            />
            <p className="text-[10px] text-amber-500/80 flex items-center gap-1 mt-1">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              This overwrites all current memory data.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MemoryPage() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Default sessions list pagination
  const [sessionsOffset, setSessionsOffset] = useState(0);
  const [allLoadedSessions, setAllLoadedSessions] = useState<MemSession[]>([]);
  const { data: sessionsPage, isLoading: sessionsLoading, isFetching: sessionsFetching } = useSessionsPage(sessionsOffset);

  useEffect(() => {
    if (!sessionsPage) return;
    if (sessionsOffset === 0) {
      setAllLoadedSessions(sessionsPage);
    } else {
      setAllLoadedSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...sessionsPage.filter(s => !seen.has(s.id))];
      });
    }
  }, [sessionsPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMoreSessions = (sessionsPage?.length ?? 0) >= SESSIONS_PAGE_SIZE;

  // Search pagination
  const [searchOffset, setSearchOffset] = useState(0);
  const [allObservations, setAllObservations] = useState<SearchResultObservation[]>([]);
  const [allSessions, setAllSessions] = useState<MemSession[]>([]);
  const [totalObservations, setTotalObservations] = useState(0);
  const [totalSessions, setTotalSessions] = useState(0);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput), 350);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  // Reset accumulated results when query or project filter changes
  useEffect(() => {
    setSearchOffset(0);
    setAllObservations([]);
    setAllSessions([]);
    setTotalObservations(0);
    setTotalSessions(0);
  }, [debouncedQuery, selectedProject]);

  const isSearching = debouncedQuery.trim().length > 1;
  const { data: searchResults, isLoading: searchLoading, isFetching } = useGlobalSearch(debouncedQuery, selectedProject, searchOffset);

  const projectPaths = useMemo(() => {
    const paths = [...new Set(allLoadedSessions.map(s => s.projectPath).filter(Boolean))].sort();
    return paths;
  }, [allLoadedSessions]);

  const filteredSessions = useMemo(() => {
    if (!selectedProject) return allLoadedSessions;
    return allLoadedSessions.filter(s => s.projectPath === selectedProject);
  }, [allLoadedSessions, selectedProject]);


  // Accumulate results as pages load (dedup by id)
  useEffect(() => {
    if (!searchResults) return;
    setTotalObservations(searchResults.totalObservations);
    setTotalSessions(searchResults.totalSessions);
    if (searchOffset === 0) {
      setAllObservations(searchResults.observations);
      setAllSessions(searchResults.sessions);
    } else {
      setAllObservations(prev => {
        const seen = new Set(prev.map(o => o.id));
        return [...prev, ...searchResults.observations.filter(o => !seen.has(o.id))];
      });
      setAllSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...searchResults.sessions.filter(s => !seen.has(s.id))];
      });
    }
  }, [searchResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMoreSearchObservations = allObservations.length < totalObservations;
  const hasMoreSearchSessions = allSessions.length < totalSessions;
  const hasMore = hasMoreSearchObservations || hasMoreSearchSessions;

  const loadMore = () => {
    setSearchOffset(prev => prev + PAGE_SIZE);
  };

  const toggleSession = (id: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sessionsWithSummaries = filteredSessions.filter(s => s.summary);
  const sessionsWithoutSummaries = filteredSessions.filter(s => !s.summary);

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
          <Brain className="w-6 h-6 text-primary" />
          Memory
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI session notes and tool observations — searchable across all sessions.
        </p>
      </div>

      {/* Filter + Search row */}
      <div className="flex gap-2 items-center">
        {/* Project path filter */}
        {projectPaths.length > 0 && (
          <div className="relative flex-shrink-0">
            <FolderOpen className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <select
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              className="pl-8 pr-8 py-2 text-xs rounded-md border border-border/50 bg-secondary/30 text-foreground appearance-none focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer min-w-[160px] max-w-[240px]"
            >
              <option value="">All projects</option>
              {projectPaths.map(p => (
                <option key={p} value={p}>{p.length > 30 ? `…${p.slice(-30)}` : p}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {/* Search bar */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search session notes and tool observations…"
            className="pl-9 pr-9 bg-secondary/30 border-border/50"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Active project filter badge */}
      {selectedProject && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtered by project:</span>
          <span className="inline-flex items-center gap-1 text-xs font-mono bg-primary/10 text-primary rounded px-2 py-0.5 border border-primary/20">
            <FolderOpen className="w-3 h-3" />
            {selectedProject.length > 40 ? `…${selectedProject.slice(-40)}` : selectedProject}
            <button
              onClick={() => setSelectedProject("")}
              className="ml-1 hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      {/* Search results */}
      {isSearching && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Search className="w-4 h-4" /> Results for &ldquo;{debouncedQuery}&rdquo;
              {selectedProject && (
                <span className="ml-1 text-[10px] font-normal normal-case text-primary/70">
                  in {selectedProject.length > 24 ? `…${selectedProject.slice(-24)}` : selectedProject}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {searchLoading && searchOffset === 0 ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : allObservations.length === 0 && allSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No results found.</p>
            ) : (
              <div className="space-y-4">
                {allSessions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Sessions — showing {allSessions.length} of {totalSessions}
                    </p>
                    <div className="space-y-2">
                      {allSessions.map(sess => (
                        <div key={sess.id} className="border border-primary/30 bg-primary/5 rounded p-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-mono text-[10px] text-primary/70 bg-primary/10 rounded px-1.5 py-0.5">
                              {sess.id.length > 20 ? `${sess.id.slice(0, 20)}…` : sess.id}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(sess.startedAt * 1000), "MMM d, yyyy HH:mm")}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {sess.observationCount} observations
                            </span>
                          </div>
                          {sess.projectPath && (
                            <p className="text-[10px] font-mono text-muted-foreground/70 mb-1">
                              {sess.projectPath}
                            </p>
                          )}
                          {sess.summary && (
                            <p className="text-xs text-foreground/90 leading-relaxed">{sess.summary}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {allObservations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Tool Observations — showing {allObservations.length} of {totalObservations}
                    </p>
                    <div className="space-y-1.5">
                      {allObservations.map(obs => (
                        <div key={obs.id} className="border border-border/40 rounded p-2 text-xs font-mono">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-primary font-semibold">{obs.toolName}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {format(new Date(obs.recordedAt * 1000), "MMM d HH:mm")}
                            </span>
                          </div>
                          {obs.inputSummary && (
                            <p className="text-muted-foreground truncate" title={obs.inputSummary}>
                              In: {obs.inputSummary}
                            </p>
                          )}
                          {obs.outputSummary && (
                            <p className="text-muted-foreground truncate" title={obs.outputSummary}>
                              Out: {obs.outputSummary}
                            </p>
                          )}
                          {obs.sessionSummary && (
                            <p className="text-muted-foreground/60 text-[10px] mt-1 border-t border-border/30 pt-1 truncate" title={obs.sessionSummary}>
                              Session: {obs.sessionSummary}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {hasMore && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMore}
                      disabled={isFetching}
                      className="gap-2"
                    >
                      {isFetching ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : null}
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Backup & Restore */}
      {!isSearching && <MemoryBackupCard />}

      {/* Default view */}
      {!isSearching && (
        <>
          {sessionsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground text-sm">
                <Brain className="w-10 h-10 mx-auto mb-3 opacity-20" />
                {selectedProject ? (
                  <>
                    <p>No sessions found for this project.</p>
                    <p className="text-xs mt-1 opacity-70">
                      Try selecting a different project or clear the filter.
                    </p>
                  </>
                ) : (
                  <>
                    <p>No memory recorded yet.</p>
                    <p className="text-xs mt-1 opacity-70">
                      Memory is captured automatically as the AI uses tools during sessions.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Sessions with summaries */}
              {sessionsWithSummaries.length > 0 && (
                <Card className="bg-card/50 border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                      <Clock className="w-4 h-4" /> Session Notes
                      <span className="ml-auto text-[10px] font-normal normal-case">
                        {sessionsWithSummaries.length} session{sessionsWithSummaries.length !== 1 ? "s" : ""}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {sessionsWithSummaries.map(sess => {
                      const isExpanded = expandedSessions.has(sess.id);
                      return (
                        <div key={sess.id} className="border border-border/40 rounded">
                          <button
                            onClick={() => toggleSession(sess.id)}
                            className="w-full flex items-center gap-2 p-2 text-left hover:bg-secondary/20 transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                            ) : (
                              <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                            )}
                            <span className="font-mono text-[10px] text-primary/60 flex-shrink-0 bg-primary/10 rounded px-1">
                              {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
                              {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                              {sess.observationCount} obs
                            </span>
                          </button>

                          {/* Summary — always shown as a note block */}
                          {sess.summary && (
                            <div className="mx-2 mb-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded text-xs text-foreground/90 leading-relaxed">
                              {sess.summary}
                            </div>
                          )}

                          {isExpanded && sess.projectPath && (
                            <div className="px-3 pb-3">
                              <span className="text-[10px] text-muted-foreground font-mono">
                                Project: {sess.projectPath}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Sessions without summaries */}
              {sessionsWithoutSummaries.length > 0 && (
                <Card className="bg-card/50 border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                      <Brain className="w-4 h-4" /> Other Sessions
                      <span className="ml-auto text-[10px] font-normal normal-case">
                        {sessionsWithoutSummaries.length} session{sessionsWithoutSummaries.length !== 1 ? "s" : ""}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {sessionsWithoutSummaries.map(sess => (
                      <div key={sess.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-border/30 text-xs">
                        <span className="font-mono text-[10px] text-primary/50 bg-primary/10 rounded px-1 flex-shrink-0">
                          {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                        </span>
                        <span className="text-muted-foreground/60 text-[10px] ml-auto">
                          {sess.observationCount} obs · no summary
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Load more sessions */}
              {hasMoreSessions && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSessionsOffset(prev => prev + SESSIONS_PAGE_SIZE)}
                    disabled={sessionsFetching}
                    className="gap-2"
                  >
                    {sessionsFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Load more sessions
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
