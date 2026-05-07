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

export interface GitHubConnectionStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
}

export function useGitHubConnection() {
  const [status, setStatus] = useState<GitHubConnectionStatus>({ connected: false, login: null, avatarUrl: null });
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}api/auth/github/status`, { headers: getOperatorAuthHeaders() });
      if (r.ok) {
        const data = await r.json() as GitHubConnectionStatus;
        setStatus(data);
      } else if (r.status === 401) {
        // Not authorized — treat as disconnected; operator hasn't entered token yet
        setStatus({ connected: false, login: null, avatarUrl: null });
      }
    } catch {
      // non-fatal — network error, treat as unknown
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // On mount: if the URL contains ?github_oauth=connected, clear all cached PATs
  // and remove the param — the operator just completed the OAuth flow.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("github_oauth");
    if (oauthResult === "connected") {
      // Clear cached PATs now that OAuth is active
      try {
        const ssKeys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith("mizi:session_pat:")) ssKeys.push(k);
        }
        ssKeys.forEach((k) => sessionStorage.removeItem(k));
        const lsKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("mizi:github_pat:") || k === "mizi_nim_github_token")) lsKeys.push(k);
        }
        lsKeys.forEach((k) => localStorage.removeItem(k));
      } catch { /* ignore */ }
      // Refresh connection status now that a token is stored
      refresh();
      // Clean up URL without reloading the page
      params.delete("github_oauth");
      const newSearch = params.toString();
      window.history.replaceState(null, "", newSearch ? `?${newSearch}` : window.location.pathname);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const r = await fetch(`${API_BASE_URL}api/auth/github`, { method: "DELETE", headers: getOperatorAuthHeaders() });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Disconnect failed (${r.status})`);
      }
      setStatus({ connected: false, login: null, avatarUrl: null });

      // Clear any locally cached PATs on disconnect
      try {
        const lsKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("mizi:github_pat:") || k === "mizi_nim_github_token")) lsKeys.push(k);
        }
        lsKeys.forEach((k) => localStorage.removeItem(k));
        const ssKeys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith("mizi:session_pat:")) ssKeys.push(k);
        }
        ssKeys.forEach((k) => sessionStorage.removeItem(k));
      } catch { /* ignore */ }
    } finally {
      setDisconnecting(false);
    }
  }, []);

  return { status, loading, disconnecting, disconnect, refresh };
}
