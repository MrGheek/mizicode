import { useState, useEffect, useCallback } from "react";
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
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
}

export function useGitHubRepos(enabled: boolean) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE_URL}api/auth/github/repos`, {
        headers: getOperatorAuthHeaders(),
      });
      if (r.ok) {
        const data = await r.json() as GitHubRepo[];
        setRepos(data);
      } else if (r.status === 404) {
        setRepos([]);
      } else {
        setError("Failed to load repos");
      }
    } catch {
      setError("Failed to load repos");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return { repos, loading, error, refresh: load };
}
