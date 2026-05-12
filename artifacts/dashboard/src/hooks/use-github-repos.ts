import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE_URL } from "@/lib/api-url";

const OPERATOR_TOKEN_LS_KEY = "mizi.ambient.operatorToken";

function getOperatorAuthHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(OPERATOR_TOKEN_LS_KEY) ?? "";
    return token ? { "Authorization": `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
}

interface ReposResponse {
  repos: GitHubRepo[];
  hasMore: boolean;
  page: number;
}

// ---------------------------------------------------------------------------
// Module-level page cache
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 30_000;
const LS_CACHE_KEY = "mizi.repoCache.page1";

interface CacheEntry {
  data: ReposResponse;
  fetchedAt: number;
}

interface SearchCacheEntry {
  repos: GitHubRepo[];
  fetchedAt: number;
}

const repoPageCache = new Map<number, CacheEntry>();
const searchCache = new Map<string, SearchCacheEntry>();

// Seed in-memory cache from localStorage on module load
(function seedFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    if (!raw) return;
    const entry = JSON.parse(raw) as CacheEntry;
    // Basic shape guard — reject corrupted or manually-set entries
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.fetchedAt !== "number" ||
      typeof entry.data !== "object" ||
      !Array.isArray(entry.data?.repos) ||
      typeof entry.data?.hasMore !== "boolean" ||
      typeof entry.data?.page !== "number"
    ) {
      localStorage.removeItem(LS_CACHE_KEY);
      return;
    }
    if (Date.now() - entry.fetchedAt <= CACHE_TTL_MS) {
      repoPageCache.set(1, entry);
    } else {
      localStorage.removeItem(LS_CACHE_KEY);
    }
  } catch {
    // ignore parse errors
  }
})();

function getCachedPage(page: number): ReposResponse | null {
  const entry = repoPageCache.get(page);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    repoPageCache.delete(page);
    if (page === 1) {
      try { localStorage.removeItem(LS_CACHE_KEY); } catch { /* ignore */ }
    }
    return null;
  }
  return entry.data;
}

function setCachedPage(data: ReposResponse): void {
  const entry: CacheEntry = { data, fetchedAt: Date.now() };
  repoPageCache.set(data.page, entry);
  if (data.page === 1) {
    try {
      localStorage.setItem(LS_CACHE_KEY, JSON.stringify(entry));
    } catch { /* ignore quota errors */ }
  }
}

function getCachedSearch(q: string): GitHubRepo[] | null {
  const entry = searchCache.get(q);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(q);
    return null;
  }
  return entry.repos;
}

function setCachedSearch(q: string, repos: GitHubRepo[]): void {
  searchCache.set(q, { repos, fetchedAt: Date.now() });
}

export function invalidateRepoCache(): void {
  repoPageCache.clear();
  searchCache.clear();
  try { localStorage.removeItem(LS_CACHE_KEY); } catch { /* ignore */ }
}
// ---------------------------------------------------------------------------

async function fetchReposPage(page: number, signal?: AbortSignal): Promise<ReposResponse> {
  const r = await fetch(`${API_BASE_URL}api/auth/github/repos?page=${page}`, {
    headers: getOperatorAuthHeaders(),
    signal,
  });
  if (r.ok) {
    const data = await r.json() as ReposResponse;
    return data;
  }
  if (r.status === 404) {
    return { repos: [], hasMore: false, page };
  }
  throw new Error("Failed to load repos");
}

async function fetchSearchRepos(q: string, signal?: AbortSignal): Promise<GitHubRepo[]> {
  const r = await fetch(
    `${API_BASE_URL}api/auth/github/repos?q=${encodeURIComponent(q)}`,
    { headers: getOperatorAuthHeaders(), signal }
  );
  if (r.ok) {
    const data = await r.json() as ReposResponse;
    return data.repos;
  }
  if (r.status === 404) return [];
  throw new Error("Failed to search repos");
}

export function useGitHubRepos(enabled: boolean) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [reconnectRequired, setReconnectRequired] = useState(false);

  // Refs for stale-request protection
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    if (!enabled) return;

    // Cancel any in-flight search or prior load
    searchAbortRef.current?.abort();
    loadAbortRef.current?.abort();
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    setSearchQuery("");
    setReconnectRequired(false);

    if (forceRefresh) {
      invalidateRepoCache();
    }

    // Serve from cache immediately if available
    const cached = getCachedPage(1);
    if (cached) {
      setRepos(cached.repos);
      setHasMore(cached.hasMore);
      setCurrentPage(1);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
    }

    // Always kick off a background refresh; show spinner only when no cache hit
    const controller = new AbortController();
    loadAbortRef.current = controller;

    try {
      const r = await fetch(`${API_BASE_URL}api/auth/github/repos?page=1`, {
        headers: getOperatorAuthHeaders(),
        signal: controller.signal,
      });
      if (r.ok) {
        const data = await r.json() as ReposResponse;
        setCachedPage(data);
        setRepos(data.repos);
        setHasMore(data.hasMore);
        setCurrentPage(1);
      } else if (r.status === 404) {
        setCachedPage({ repos: [], hasMore: false, page: 1 });
        setRepos([]);
        setHasMore(false);
      } else if (r.status === 401) {
        const body = await r.json().catch(() => ({})) as { reconnect_required?: boolean };
        if (body.reconnect_required) {
          setReconnectRequired(true);
          setRepos([]);
          setHasMore(false);
        } else if (!cached) {
          setError("Failed to load repos");
        }
      } else if (!cached) {
        setError("Failed to load repos");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        if (!cached) {
          setError("Failed to load repos");
        }
      }
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  const refresh = useCallback(() => load(true), [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || searchQuery) return;
    setLoadingMore(true);
    const nextPage = currentPage + 1;
    try {
      // Check cache first
      const cached = getCachedPage(nextPage);
      if (cached) {
        setRepos((prev) => {
          const existingKeys = new Set(prev.map((r) => r.fullName));
          const fresh = cached.repos.filter((r) => !existingKeys.has(r.fullName));
          return [...prev, ...fresh];
        });
        setHasMore(cached.hasMore);
        setCurrentPage(nextPage);
      } else {
        const data = await fetchReposPage(nextPage);
        setCachedPage(data);
        setRepos((prev) => {
          const existingKeys = new Set(prev.map((r) => r.fullName));
          const fresh = data.repos.filter((r) => !existingKeys.has(r.fullName));
          return [...prev, ...fresh];
        });
        setHasMore(data.hasMore);
        setCurrentPage(nextPage);
      }
    } catch {
      setError("Failed to load more repos");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, searchQuery, currentPage]);

  const search = useCallback(
    (q: string) => {
      // Clear any pending debounce and abort prior search request
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchAbortRef.current?.abort();

      setSearchQuery(q);

      if (!q.trim()) {
        // Revert to the first browsed page
        load();
        return;
      }

      const trimmed = q.trim();

      // Serve from cache immediately if available — no spinner, no network call
      const cached = getCachedSearch(trimmed);
      if (cached) {
        setRepos(cached);
        setHasMore(false);
        setError(null);
        setLoading(false);
        return;
      }

      searchDebounceRef.current = setTimeout(async () => {
        const controller = new AbortController();
        searchAbortRef.current = controller;

        setLoading(true);
        setError(null);
        try {
          const results = await fetchSearchRepos(trimmed, controller.signal);
          setCachedSearch(trimmed, results);
          setRepos(results);
          setHasMore(false);
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            setError("Search failed");
          }
        } finally {
          setLoading(false);
        }
      }, 350);
    },
    [load]
  );

  useEffect(() => {
    load();
  }, [load]);

  return {
    repos,
    loading,
    loadingMore,
    error,
    reconnectRequired,
    hasMore,
    searchQuery,
    search,
    loadMore,
    refresh,
  };
}
