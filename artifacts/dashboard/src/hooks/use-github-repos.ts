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

  const load = useCallback(async () => {
    if (!enabled) return;

    // Cancel any in-flight search or prior load
    searchAbortRef.current?.abort();
    loadAbortRef.current?.abort();
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoading(true);
    setError(null);
    setSearchQuery("");
    setReconnectRequired(false);
    try {
      const r = await fetch(`${API_BASE_URL}api/auth/github/repos?page=1`, {
        headers: getOperatorAuthHeaders(),
        signal: controller.signal,
      });
      if (r.ok) {
        const data = await r.json() as ReposResponse;
        setRepos(data.repos);
        setHasMore(data.hasMore);
        setCurrentPage(1);
      } else if (r.status === 404) {
        setRepos([]);
        setHasMore(false);
      } else if (r.status === 401) {
        const body = await r.json().catch(() => ({})) as { reconnect_required?: boolean };
        if (body.reconnect_required) {
          setReconnectRequired(true);
          setRepos([]);
          setHasMore(false);
        } else {
          setError("Failed to load repos");
        }
      } else {
        setError("Failed to load repos");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError("Failed to load repos");
      }
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || searchQuery) return;
    setLoadingMore(true);
    try {
      const nextPage = currentPage + 1;
      const data = await fetchReposPage(nextPage);
      setRepos((prev) => {
        const existingKeys = new Set(prev.map((r) => r.fullName));
        const fresh = data.repos.filter((r) => !existingKeys.has(r.fullName));
        return [...prev, ...fresh];
      });
      setHasMore(data.hasMore);
      setCurrentPage(nextPage);
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

      searchDebounceRef.current = setTimeout(async () => {
        const controller = new AbortController();
        searchAbortRef.current = controller;

        setLoading(true);
        setError(null);
        try {
          const results = await fetchSearchRepos(q.trim(), controller.signal);
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
    refresh: load
  };
}
