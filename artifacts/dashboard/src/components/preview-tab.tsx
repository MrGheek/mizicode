import { useState, useEffect, useRef, useCallback } from "react";
import {
  Monitor, Tablet, Smartphone, ArrowLeft, ArrowRight,
  RefreshCw, RotateCcw, ExternalLink, ChevronDown, ChevronUp,
  Camera, Terminal, X, Loader2, Play, WifiOff, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";
import { formatDistanceToNow } from "date-fns";

type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORT_DIMS: Record<Viewport, { w: number; h: number }> = {
  desktop: { w: 1280, h: 720 },
  tablet:  { w: 768,  h: 1024 },
  mobile:  { w: 390,  h: 844 },
};

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: number;
  source?: string;
  lineNumber?: number;
}

interface Screenshot {
  imageBase64: string;
  mimeType?: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  url: string;
}

interface MemObs {
  toolName?: string;
  [key: string]: unknown;
}

interface PreviewTabProps {
  sessionId: number;
  previewUrl: string | null;
  boltDiyUrl: string | null;
  codeServerUrl: string | null;
  isReady: boolean;
}

const FILE_TOOL_NAMES = new Set([
  "file_write", "write_file", "write_to_file", "create_file", "edit_file",
  "str_replace_editor", "bash", "shell_exec", "shell_command", "run_terminal_cmd",
]);

const SMART_RETRY_INTERVAL_MS = 5_000;
const SMART_RETRY_MAX = 12; // 60 s total

function swapPort(currentUrl: string, targetUrl: string): string {
  try {
    const cur = new URL(currentUrl);
    const tgt = new URL(targetUrl);
    cur.hostname = tgt.hostname;
    cur.port = tgt.port;
    return cur.toString();
  } catch {
    return targetUrl;
  }
}

function resolveDefaultUrl(previewUrl: string | null): string {
  return previewUrl ?? "";
}

export function PreviewTab({
  sessionId,
  previewUrl,
  boltDiyUrl,
  codeServerUrl,
  isReady,
}: PreviewTabProps) {
  const sk = `preview-tab-${sessionId}`;

  const storedUrl      = sessionStorage.getItem(`${sk}-url`);
  const storedViewport = (sessionStorage.getItem(`${sk}-viewport`) as Viewport | null) ?? "desktop";
  const storedSSOpen   = sessionStorage.getItem(`${sk}-ss-open`) === "1";
  const storedConOpen  = sessionStorage.getItem(`${sk}-con-open`) === "1";

  const [url, setUrl]           = useState(() => storedUrl ?? resolveDefaultUrl(previewUrl));
  const [inputVal, setInputVal] = useState(() => storedUrl ?? resolveDefaultUrl(previewUrl));
  const [iframeKey, setIframeKey] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(storedViewport);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [smartRetryCount, setSmartRetryCount] = useState(0);
  const [smartRetryCountdown, setSmartRetryCountdown] = useState(0);

  const [history, setHistory] = useState<string[]>(() => {
    const d = resolveDefaultUrl(previewUrl);
    return [storedUrl ?? d].filter(Boolean);
  });
  const [histIdx, setHistIdx] = useState(0);

  const [screenshotOpen, setScreenshotOpen] = useState(storedSSOpen);
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [loadingLastSS, setLoadingLastSS] = useState(false);

  const [consoleOpen, setConsoleOpen] = useState(storedConOpen);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const [capturingConsole, setCapturingConsole] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(false);

  const fallbackTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const persistUrl      = useCallback((u: string) => sessionStorage.setItem(`${sk}-url`, u), [sk]);
  const persistViewport = useCallback((v: Viewport) => sessionStorage.setItem(`${sk}-viewport`, v), [sk]);
  const persistSSOpen   = useCallback((v: boolean) => sessionStorage.setItem(`${sk}-ss-open`, v ? "1" : "0"), [sk]);
  const persistConOpen  = useCallback((v: boolean) => sessionStorage.setItem(`${sk}-con-open`, v ? "1" : "0"), [sk]);

  const clearTimers = useCallback(() => {
    if (fallbackTimerRef.current)  { clearTimeout(fallbackTimerRef.current);   fallbackTimerRef.current  = null; }
    if (retryTimerRef.current)     { clearTimeout(retryTimerRef.current);      retryTimerRef.current     = null; }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
  }, []);

  const startLoad = useCallback(() => {
    clearTimers();
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    setSmartRetryCount(0);
    setSmartRetryCountdown(0);
    setIframeKey(k => k + 1);
    fallbackTimerRef.current = setTimeout(() => {
      setIsLoading(false);
      setShowFallback(true);
    }, 8_000);
  }, [clearTimers]);

  const navigate = useCallback((targetUrl: string) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    setUrl(trimmed);
    setInputVal(trimmed);
    persistUrl(trimmed);
    setHistory(prev => {
      const slice = prev.slice(0, histIdx + 1);
      const next = [...slice, trimmed];
      setHistIdx(next.length - 1);
      return next;
    });
    startLoad();
  }, [histIdx, persistUrl, startLoad]);

  const reload = useCallback(() => {
    startLoad();
  }, [startLoad]);

  const hardReload = useCallback(() => {
    if (!url) return;
    try {
      const u = new URL(url);
      u.searchParams.set("_r", String(Date.now()));
      setUrl(u.toString());
      setInputVal(url);
    } catch {
      // fallback: just reload normally
    }
    startLoad();
  }, [url, startLoad]);

  const goBack = useCallback(() => {
    const newIdx = histIdx - 1;
    if (newIdx < 0) return;
    const target = history[newIdx];
    if (!target) return;
    setHistIdx(newIdx);
    setUrl(target);
    setInputVal(target);
    persistUrl(target);
    startLoad();
  }, [histIdx, history, persistUrl, startLoad]);

  const goForward = useCallback(() => {
    const newIdx = histIdx + 1;
    if (newIdx >= history.length) return;
    const target = history[newIdx];
    if (!target) return;
    setHistIdx(newIdx);
    setUrl(target);
    setInputVal(target);
    persistUrl(target);
    startLoad();
  }, [histIdx, history, persistUrl, startLoad]);

  const handleIframeLoad = useCallback(() => {
    clearTimers();
    setIsLoading(false);
    setLoadedOnce(true);
    setShowFallback(false);
    setSmartRetryCount(0);
    setSmartRetryCountdown(0);
  }, [clearTimers]);

  const startSmartRetry = useCallback((retryCount: number) => {
    if (retryCount >= SMART_RETRY_MAX) return;
    clearTimers();
    setSmartRetryCountdown(Math.round(SMART_RETRY_INTERVAL_MS / 1000));
    countdownTimerRef.current = setInterval(() => {
      setSmartRetryCountdown(c => {
        if (c <= 1) {
          if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
          return 0;
        }
        return c - 1;
      });
    }, 1_000);
    retryTimerRef.current = setTimeout(() => {
      const next = retryCount + 1;
      setSmartRetryCount(next);
      setIsLoading(true);
      setLoadedOnce(false);
      setShowFallback(false);
      setIframeKey(k => k + 1);
      fallbackTimerRef.current = setTimeout(() => {
        setIsLoading(false);
        setShowFallback(true);
        startSmartRetry(next);
      }, 8_000);
    }, SMART_RETRY_INTERVAL_MS);
  }, [clearTimers]);

  useEffect(() => {
    if (showFallback && smartRetryCount < SMART_RETRY_MAX) {
      startSmartRetry(smartRetryCount);
    }
  }, [showFallback]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    persistViewport(viewport);
  }, [viewport, persistViewport]);

  useEffect(() => {
    if (!autoRefresh) return;
    const esUrl = `${BASE_URL}api/sessions/${sessionId}/memory/stream`;
    const es = new EventSource(esUrl);
    es.onmessage = (event) => {
      try {
        const obs = JSON.parse(event.data) as MemObs;
        if (obs.toolName && FILE_TOOL_NAMES.has(obs.toolName)) {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(() => {
            startLoad();
          }, 3_000);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => es.close();
    return () => {
      es.close();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [autoRefresh, sessionId, startLoad]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const fetchLastScreenshot = useCallback(async () => {
    setLoadingLastSS(true);
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/tools/last-screenshot`);
      if (res.ok) {
        const data = await res.json() as Screenshot;
        setScreenshot(data);
      }
    } catch { /* not fatal */ }
    finally { setLoadingLastSS(false); }
  }, [sessionId]);

  const openScreenshotStrip = useCallback(() => {
    setScreenshotOpen(true);
    persistSSOpen(true);
    if (!screenshot) fetchLastScreenshot();
  }, [screenshot, fetchLastScreenshot, persistSSOpen]);

  const closeScreenshotStrip = useCallback(() => {
    setScreenshotOpen(false);
    persistSSOpen(false);
  }, [persistSSOpen]);

  const openConsole = useCallback(() => {
    setConsoleOpen(true);
    persistConOpen(true);
  }, [persistConOpen]);

  const closeConsole = useCallback(() => {
    setConsoleOpen(false);
    persistConOpen(false);
  }, [persistConOpen]);

  useEffect(() => {
    if (storedSSOpen && !screenshot) {
      fetchLastScreenshot();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const takeScreenshot = async () => {
    if (!url || takingScreenshot) return;
    setTakingScreenshot(true);
    setScreenshotError(null);
    try {
      const vp = VIEWPORT_DIMS[viewport];
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/tools/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, viewportWidth: vp.w, viewportHeight: vp.h }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setScreenshotError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json() as Screenshot;
        setScreenshot(data);
        if (!screenshotOpen) openScreenshotStrip();
      }
    } catch (err) {
      setScreenshotError(err instanceof Error ? err.message : "Failed");
    } finally {
      setTakingScreenshot(false);
    }
  };

  const captureConsole = async () => {
    if (!url || capturingConsole) return;
    setCapturingConsole(true);
    setConsoleError(null);
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/tools/console-capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, durationMs: 5000 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setConsoleError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json() as { logs: ConsoleEntry[] };
        setConsoleLogs(prev => [...prev, ...data.logs.map(l => ({ ...l, timestamp: l.timestamp ?? Date.now() }))]);
        if (!consoleOpen) openConsole();
      }
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : "Failed");
    } finally {
      setCapturingConsole(false);
    }
  };

  const portChips: { label: string; url: string; newTab?: boolean }[] = [
    ...(previewUrl    ? [{ label: "3000", url: previewUrl }]                         : []),
    ...(boltDiyUrl    ? [{ label: "5180", url: boltDiyUrl,    newTab: true }]        : []),
    ...(codeServerUrl ? [{ label: "8080", url: codeServerUrl, newTab: true }]        : []),
  ];

  const noUrl = !url;
  const sessionNotReady = !isReady && !loadedOnce;
  const vw = VIEWPORT_DIMS[viewport].w;

  const logLevelClass = (level: string) => {
    if (level === "error") return "text-red-400";
    if (level === "warn")  return "text-amber-400";
    if (level === "info")  return "text-sky-400";
    return "text-muted-foreground";
  };

  const ssViewportLabel = screenshot
    ? `${screenshot.viewport.width}×${screenshot.viewport.height}`
    : "";

  return (
    <div className="flex flex-col gap-2">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap">
        <button
          onClick={goBack}
          disabled={histIdx <= 0}
          title="Back"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={goForward}
          disabled={histIdx >= history.length - 1}
          title="Forward"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={reload}
          title="Reload"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading && url ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={hardReload}
          disabled={!url}
          title="Hard reload (bypass cache)"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>

        <Input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              let val = inputVal.trim();
              if (val && !val.startsWith("http://") && !val.startsWith("https://")) val = `http://${val}`;
              navigate(val);
            }
          }}
          placeholder="http://..."
          className="flex-1 h-7 text-xs font-mono bg-secondary/30 border-border/50 min-w-0"
          spellCheck={false}
        />

        <button
          onClick={() => url && window.open(url, "_blank", "noopener")}
          disabled={!url}
          title="Open in new tab"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Port chips + Viewport + Auto-refresh ─────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {portChips.map(chip => {
          const swapped = url ? swapPort(url, chip.url) : chip.url;
          const active  = !chip.newTab && (url === chip.url || url === swapped);
          return (
            <button
              key={chip.label}
              onClick={() => chip.newTab
                ? window.open(swapped, "_blank", "noopener,noreferrer")
                : navigate(swapped)
              }
              title={chip.newTab ? `Open ${swapped} in new tab` : swapped}
              className={`flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border transition-colors ${
                active
                  ? "bg-primary/15 text-primary border-primary/40"
                  : "bg-secondary/40 text-muted-foreground border-border/40 hover:border-primary/30 hover:text-foreground"
              }`}
            >
              :{chip.label}
              {chip.newTab && <ExternalLink className="w-2.5 h-2.5 ml-0.5 opacity-60" />}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          {([
            { id: "desktop" as Viewport, icon: <Monitor    className="w-3 h-3" />, label: "Desktop 1280px" },
            { id: "tablet"  as Viewport, icon: <Tablet     className="w-3 h-3" />, label: "Tablet 768px"   },
            { id: "mobile"  as Viewport, icon: <Smartphone className="w-3 h-3" />, label: "Mobile 390px"   },
          ] as const).map(({ id, icon, label }) => (
            <button
              key={id}
              onClick={() => setViewport(id)}
              title={label}
              className={`p-1.5 rounded transition-colors ${
                viewport === id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {icon}
            </button>
          ))}

          <button
            onClick={() => setAutoRefresh(r => !r)}
            title={autoRefresh ? "Auto-refresh: ON" : "Auto-refresh: OFF"}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ml-1 ${
              autoRefresh
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : "text-muted-foreground border-border/40 hover:border-border/70"
            }`}
          >
            <Play className="w-2.5 h-2.5" />
            Auto
          </button>
        </div>
      </div>

      {/* ── iframe area ─────────────────────────────────────────── */}
      <div
        className="relative rounded-lg border border-border/40 overflow-hidden bg-background mx-auto w-full"
        style={{
          maxWidth: vw < 520 ? `${vw}px` : "100%",
          height: `calc(100vh - 240px)`,
          minHeight: "400px",
        }}
      >
        {noUrl && boltDiyUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(99,102,241,0.15)" }}>
              <Terminal className="w-6 h-6" style={{ color: "#818cf8" }} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-semibold">Bolt.diy can't be embedded here</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                The coding environment blocks iframe embedding for security. Open it in a new tab to start coding.
              </p>
            </div>
            <a
              href={boltDiyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: "rgba(99,102,241,0.15)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.3)" }}
            >
              <ExternalLink className="w-4 h-4" />
              Open Bolt.diy
            </a>
            <p className="text-[11px] text-muted-foreground opacity-60">
              App preview (port 3000) will appear here once your app is running.
            </p>
          </div>
        )}

        {noUrl && !boltDiyUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <WifiOff className="w-8 h-8 opacity-20" />
            <p className="text-xs">No preview URL available yet.</p>
            <p className="text-[11px] opacity-60">Enter a URL above or wait for the session to start.</p>
          </div>
        )}

        {!noUrl && sessionNotReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 z-10">
            <Loader2 className="w-6 h-6 animate-spin opacity-40" />
            <p className="text-xs text-muted-foreground">Waiting for session to be ready…</p>
          </div>
        )}

        {!noUrl && isReady && isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90 z-10">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading preview…</span>
          </div>
        )}

        {!noUrl && isReady && showFallback && !isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 z-10 px-6 text-center">
            <AlertTriangle className="w-8 h-8 opacity-25" />
            <p className="text-sm font-medium">Preview not available</p>
            <p className="text-xs text-muted-foreground">
              {smartRetryCount >= SMART_RETRY_MAX
                ? "The server did not respond after 60 s. It may still be starting up."
                : "The server may still be starting up, or it blocks embedding via X-Frame-Options / CSP."}
            </p>
            {smartRetryCount < SMART_RETRY_MAX && smartRetryCountdown > 0 && (
              <p className="text-[11px] text-muted-foreground/60">
                Auto-retrying in {smartRetryCountdown}s ({SMART_RETRY_MAX - smartRetryCount} attempts left)
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5" onClick={reload}>
                <RefreshCw className="w-3 h-3" /> Retry now
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5" onClick={() => window.open(url, "_blank", "noopener")}>
                <ExternalLink className="w-3 h-3" /> Open in new tab
              </Button>
            </div>
          </div>
        )}

        {!noUrl && isReady && (
          <iframe
            key={iframeKey}
            src={url}
            onLoad={handleIframeLoad}
            onError={() => { setIsLoading(false); setShowFallback(true); }}
            className="w-full h-full border-0"
            title="Project preview"
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>

      {/* ── Agent screenshot strip ───────────────────────────────── */}
      <div className="rounded-lg border border-border/40 overflow-hidden">
        <button
          onClick={() => screenshotOpen ? closeScreenshotStrip() : openScreenshotStrip()}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Camera className="w-3 h-3" />
            Agent screenshot
            {loadingLastSS && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={e => { e.stopPropagation(); takeScreenshot(); }}
              disabled={takingScreenshot || !url}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border/50 bg-secondary/30 hover:bg-accent disabled:opacity-40 transition-colors"
              title="Take screenshot now"
            >
              {takingScreenshot ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Camera className="w-2.5 h-2.5" />}
              Capture
            </button>
            {screenshotOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </button>

        {screenshotOpen && (
          <div className="px-3 pb-3 space-y-2">
            {screenshotError && (
              <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
                {screenshotError}
              </p>
            )}
            {screenshot ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="font-mono truncate max-w-[60%]" title={screenshot.url}>{screenshot.url}</span>
                  <span>
                    {formatDistanceToNow(new Date(screenshot.capturedAt), { addSuffix: true })}
                    {ssViewportLabel ? ` · ${ssViewportLabel}` : ""}
                  </span>
                </div>
                <img
                  src={`data:image/png;base64,${screenshot.imageBase64}`}
                  alt="Agent screenshot"
                  className="w-full rounded border border-border/40 object-contain"
                  style={{ maxHeight: "220px" }}
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-3">
                {loadingLastSS ? "Loading last screenshot…" : <>No screenshot yet. Click <strong>Capture</strong> to take one.</>}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Console log drawer ───────────────────────────────────── */}
      <div className="rounded-lg border border-border/40 overflow-hidden">
        <button
          onClick={() => consoleOpen ? closeConsole() : openConsole()}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Terminal className="w-3 h-3" />
            Console
            {consoleLogs.filter(l => l.level === "error").length > 0 && (
              <span className="px-1 py-0 rounded-full bg-red-500/20 text-red-400 text-[9px] font-semibold">
                {consoleLogs.filter(l => l.level === "error").length} errors
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={e => { e.stopPropagation(); captureConsole(); }}
              disabled={capturingConsole || !url}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border/50 bg-secondary/30 hover:bg-accent disabled:opacity-40 transition-colors"
              title="Capture 5s of console output"
            >
              {capturingConsole ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Play className="w-2.5 h-2.5" />}
              {capturingConsole ? "Capturing…" : "Capture 5s"}
            </button>
            {consoleLogs.length > 0 && (
              <button
                onClick={e => { e.stopPropagation(); setConsoleLogs([]); }}
                className="text-[10px] px-1.5 py-0.5 rounded border border-border/50 bg-secondary/30 hover:bg-accent transition-colors"
                title="Clear logs"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
            {consoleOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </button>

        {consoleOpen && (
          <div className="px-3 pb-3 space-y-1.5">
            {consoleError && (
              <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
                {consoleError}
              </p>
            )}
            {consoleLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                Click <strong>Capture 5s</strong> to record console output.
              </p>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-[10px] bg-black/20 rounded p-2">
                {consoleLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[8px] px-1 py-0 h-3.5 shrink-0 border-0 font-semibold uppercase ${
                        log.level === "error" ? "bg-red-500/20 text-red-400"
                        : log.level === "warn"  ? "bg-amber-500/20 text-amber-400"
                        : log.level === "info"  ? "bg-sky-500/20 text-sky-400"
                        : "bg-secondary/50 text-muted-foreground"
                      }`}
                    >
                      {log.level}
                    </Badge>
                    <span className={`break-all leading-relaxed ${logLevelClass(log.level)}`}>
                      {log.message}
                      {(log.source || log.lineNumber) && (
                        <span className="text-muted-foreground/50 ml-1 text-[9px]">
                          {log.source}
                          {log.lineNumber != null ? `:${log.lineNumber}` : ""}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
