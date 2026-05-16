import { useState, useEffect, useRef, useCallback } from "react";
import {
  Monitor, Tablet, Smartphone, ArrowLeft, ArrowRight,
  RefreshCw, ExternalLink, ChevronDown, ChevronUp,
  Camera, Terminal, X, Loader2, Play, WifiOff,
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
  text: string;
  source?: string;
  lineNumber?: number;
  timestamp: number;
}

interface Screenshot {
  imageBase64: string;
  capturedAt: string;
  viewport: Viewport;
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

function resolveDefaultUrl(
  previewUrl: string | null,
  boltDiyUrl: string | null,
): string {
  return previewUrl ?? boltDiyUrl ?? "";
}

const FILE_TOOL_NAMES = new Set([
  "file_write", "write_file", "write_to_file", "create_file", "edit_file",
  "str_replace_editor", "bash", "shell_exec", "shell_command",
  "run_terminal_cmd",
]);

export function PreviewTab({
  sessionId,
  previewUrl,
  boltDiyUrl,
  codeServerUrl,
  isReady,
}: PreviewTabProps) {
  const storageKey = `preview-tab-${sessionId}`;
  const storedUrl = sessionStorage.getItem(`${storageKey}-url`);
  const storedViewport = (sessionStorage.getItem(`${storageKey}-viewport`) as Viewport) ?? "desktop";

  const [url, setUrl] = useState<string>(storedUrl ?? resolveDefaultUrl(previewUrl, boltDiyUrl));
  const [inputVal, setInputVal] = useState<string>(storedUrl ?? resolveDefaultUrl(previewUrl, boltDiyUrl));
  const [iframeKey, setIframeKey] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(storedViewport);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [showFallback, setShowFallback] = useState(false);

  const [history, setHistory] = useState<string[]>(() => {
    const d = resolveDefaultUrl(previewUrl, boltDiyUrl);
    return d ? [storedUrl ?? d] : [];
  });
  const [histIdx, setHistIdx] = useState(0);

  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const [capturingConsole, setCapturingConsole] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistUrl = useCallback((u: string) => {
    sessionStorage.setItem(`${storageKey}-url`, u);
  }, [storageKey]);

  const persistViewport = useCallback((v: Viewport) => {
    sessionStorage.setItem(`${storageKey}-viewport`, v);
  }, [storageKey]);

  const navigate = useCallback((targetUrl: string) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    setUrl(trimmed);
    setInputVal(trimmed);
    persistUrl(trimmed);
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    setIframeKey(k => k + 1);
    setHistory(prev => {
      const slice = prev.slice(0, histIdx + 1);
      const next = [...slice, trimmed];
      setHistIdx(next.length - 1);
      return next;
    });
  }, [histIdx, persistUrl]);

  const goBack = () => {
    const newIdx = histIdx - 1;
    if (newIdx < 0) return;
    const target = history[newIdx];
    if (!target) return;
    setHistIdx(newIdx);
    setUrl(target);
    setInputVal(target);
    persistUrl(target);
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    setIframeKey(k => k + 1);
  };

  const goForward = () => {
    const newIdx = histIdx + 1;
    if (newIdx >= history.length) return;
    const target = history[newIdx];
    if (!target) return;
    setHistIdx(newIdx);
    setUrl(target);
    setInputVal(target);
    persistUrl(target);
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    setIframeKey(k => k + 1);
  };

  const reload = () => {
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    setIframeKey(k => k + 1);
  };

  const handleIframeLoad = () => {
    setIsLoading(false);
    setLoadedOnce(true);
    setShowFallback(false);
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!url) return;
    setIsLoading(true);
    setLoadedOnce(false);
    setShowFallback(false);
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      setIsLoading(false);
      setShowFallback(true);
    }, 8000);
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    };
  }, [iframeKey, url]);

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
            setIsLoading(true);
            setLoadedOnce(false);
            setShowFallback(false);
            setIframeKey(k => k + 1);
          }, 3000);
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => es.close();
    return () => {
      es.close();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [autoRefresh, sessionId]);

  const takeScreenshot = async () => {
    if (!url || takingScreenshot) return;
    setTakingScreenshot(true);
    setScreenshotError(null);
    try {
      const res = await fetch(`${BASE_URL}api/sessions/${sessionId}/tools/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          viewportWidth: VIEWPORT_DIMS[viewport].w,
          viewportHeight: VIEWPORT_DIMS[viewport].h,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setScreenshotError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json() as { imageBase64: string; capturedAt: string };
        setScreenshot({ imageBase64: data.imageBase64, capturedAt: data.capturedAt, viewport, url });
        setScreenshotOpen(true);
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
        setConsoleLogs(prev => [
          ...prev,
          ...data.logs.map(l => ({ ...l, timestamp: Date.now() })),
        ]);
        setConsoleOpen(true);
      }
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : "Failed");
    } finally {
      setCapturingConsole(false);
    }
  };

  const portChips: { label: string; url: string }[] = [
    ...(previewUrl ? [{ label: "3000", url: previewUrl }] : []),
    ...(boltDiyUrl  ? [{ label: "5180", url: boltDiyUrl }]  : []),
    ...(codeServerUrl ? [{ label: "8080", url: codeServerUrl }] : []),
  ];

  const noUrl = !url;
  const sessionNotReady = !isReady && !loadedOnce;

  const logLevelClass = (level: string) => {
    if (level === "error") return "text-red-400";
    if (level === "warn")  return "text-amber-400";
    if (level === "info")  return "text-sky-400";
    return "text-muted-foreground";
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Back / Forward */}
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

        {/* Refresh */}
        <button
          onClick={reload}
          title="Reload"
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading && url ? "animate-spin" : ""}`} />
        </button>

        {/* URL bar */}
        <Input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              let val = inputVal.trim();
              if (val && !val.startsWith("http://") && !val.startsWith("https://")) {
                val = `http://${val}`;
              }
              navigate(val);
            }
          }}
          placeholder="http://..."
          className="flex-1 h-7 text-xs font-mono bg-secondary/30 border-border/50 min-w-0"
          spellCheck={false}
        />

        {/* Open in new tab */}
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
        {portChips.map(chip => (
          <button
            key={chip.label}
            onClick={() => navigate(chip.url)}
            title={chip.url}
            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border transition-colors ${
              url === chip.url
                ? "bg-primary/15 text-primary border-primary/40"
                : "bg-secondary/40 text-muted-foreground border-border/40 hover:border-primary/30 hover:text-foreground"
            }`}
          >
            :{chip.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1">
          {/* Viewport toggle */}
          {([
            { id: "desktop" as Viewport, icon: <Monitor className="w-3 h-3" />, label: "Desktop 1280px" },
            { id: "tablet"  as Viewport, icon: <Tablet  className="w-3 h-3" />, label: "Tablet 768px" },
            { id: "mobile"  as Viewport, icon: <Smartphone className="w-3 h-3" />, label: "Mobile 390px" },
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

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(r => !r)}
            title={autoRefresh ? "Auto-refresh on agent step: ON" : "Auto-refresh on agent step: OFF"}
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
      <div className="relative rounded-lg border border-border/40 overflow-hidden bg-background" style={{ height: "380px" }}>
        {/* Empty state — no URL */}
        {noUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <WifiOff className="w-8 h-8 opacity-20" />
            <p className="text-xs">No preview URL available yet.</p>
            <p className="text-[11px] opacity-60">Enter a URL above or wait for the session to start.</p>
          </div>
        )}

        {/* Session not ready overlay */}
        {!noUrl && sessionNotReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 z-10">
            <Loader2 className="w-6 h-6 animate-spin opacity-40" />
            <p className="text-xs text-muted-foreground">Waiting for session to be ready…</p>
          </div>
        )}

        {/* Loading overlay */}
        {!noUrl && isReady && isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90 z-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs">Loading preview…</span>
            </div>
          </div>
        )}

        {/* Cross-origin / CSP fallback */}
        {!noUrl && isReady && showFallback && !isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 z-10 px-6 text-center">
            <WifiOff className="w-8 h-8 opacity-25" />
            <p className="text-sm font-medium">This page cannot be embedded.</p>
            <p className="text-xs text-muted-foreground">
              The server may not be running, or the page blocks embedding via X-Frame-Options / CSP.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5" onClick={reload}>
                <RefreshCw className="w-3 h-3" /> Retry
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5" onClick={() => window.open(url, "_blank", "noopener")}>
                <ExternalLink className="w-3 h-3" /> Open in new tab
              </Button>
            </div>
          </div>
        )}

        {/* iframe */}
        {!noUrl && isReady && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
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
          onClick={() => setScreenshotOpen(o => !o)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Camera className="w-3 h-3" />
            Agent screenshot
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
                    {formatDistanceToNow(new Date(screenshot.capturedAt), { addSuffix: true })} · {VIEWPORT_DIMS[screenshot.viewport].w}×{VIEWPORT_DIMS[screenshot.viewport].h}
                  </span>
                </div>
                <img
                  src={`data:image/png;base64,${screenshot.imageBase64}`}
                  alt="Agent screenshot"
                  className="w-full rounded border border-border/40 object-contain"
                  style={{ maxHeight: "200px" }}
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-3">
                No screenshot yet. Click <strong>Capture</strong> to take one.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Console log drawer ───────────────────────────────────── */}
      <div className="rounded-lg border border-border/40 overflow-hidden">
        <button
          onClick={() => setConsoleOpen(o => !o)}
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
              title="Capture 5s of console logs"
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
                      {log.text}
                      {log.source && (
                        <span className="text-muted-foreground/50 ml-1">
                          ({log.source}{log.lineNumber ? `:${log.lineNumber}` : ""})
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
