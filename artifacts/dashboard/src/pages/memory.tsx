import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Brain, Search, X, Clock, ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect, useRef, useMemo } from "react";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

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
}

function useAllSessions() {
  return useQuery<MemSession[]>({
    queryKey: ["mem-all-sessions"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/sessions`);
      if (!res.ok) throw new Error("Failed to fetch memory sessions");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

function useGlobalSearch(query: string, projectPath: string) {
  const params = new URLSearchParams({ q: query });
  if (projectPath) params.set("projectPath", projectPath);
  return useQuery<MemorySearchResult>({
    queryKey: ["mem-global-search", query, projectPath],
    enabled: query.trim().length > 1,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/search?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to search memory");
      return res.json();
    },
    staleTime: 5000,
  });
}

export default function MemoryPage() {
  const { data: sessions, isLoading: sessionsLoading } = useAllSessions();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput), 350);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  const isSearching = debouncedQuery.trim().length > 1;
  const { data: searchResults, isLoading: searchLoading } = useGlobalSearch(debouncedQuery, selectedProject);

  const projectPaths = useMemo(() => {
    if (!sessions) return [];
    const paths = [...new Set(sessions.map(s => s.projectPath).filter(Boolean))].sort();
    return paths;
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!selectedProject) return sessions;
    return sessions.filter(s => s.projectPath === selectedProject);
  }, [sessions, selectedProject]);

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
            {searchLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : !searchResults || (searchResults.observations.length === 0 && searchResults.sessions.length === 0) ? (
              <p className="text-sm text-muted-foreground text-center py-6">No results found.</p>
            ) : (
              <div className="space-y-4">
                {searchResults.sessions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Sessions ({searchResults.sessions.length})
                    </p>
                    <div className="space-y-2">
                      {searchResults.sessions.map(sess => (
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

                {searchResults.observations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Tool Observations ({searchResults.observations.length})
                    </p>
                    <div className="space-y-1.5">
                      {searchResults.observations.map(obs => (
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
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
            </>
          )}
        </>
      )}
    </div>
  );
}
