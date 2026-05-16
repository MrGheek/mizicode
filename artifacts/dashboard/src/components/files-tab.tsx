import { useState, useCallback, useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { Loader2, ChevronRight, ChevronDown, Folder, FolderOpen, File, Save, AlertCircle, FolderX, RefreshCw, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
}

interface FileNode {
  name: string;
  type: "file" | "dir";
  size: number;
  path: string;
}

function getLanguageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "py":
      return python();
    case "css":
    case "scss":
    case "less":
      return css();
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
      return html();
    case "md":
    case "mdx":
      return markdown();
    default:
      return null;
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface TreeNodeProps {
  sessionId: number;
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  depth: number;
  ownerToken: string | undefined;
}

function TreeNode({ sessionId, node, selectedPath, onSelectFile, depth, ownerToken }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDir = async () => {
    if (node.type !== "dir") return;
    if (!expanded) {
      if (!children) {
        setLoading(true);
        setError(null);
        try {
          const tokenParam = ownerToken ? `&token=${encodeURIComponent(ownerToken)}` : "";
          const entries = await apiFetch<FileEntry[]>(
            `${BASE_URL}api/sessions/${sessionId}/files?path=${encodeURIComponent(node.path)}${tokenParam}`
          );
          setChildren(entries.map((e) => ({ ...e, path: `${node.path}/${e.name}` })));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load");
        } finally {
          setLoading(false);
        }
      }
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  const isSelected = selectedPath === node.path;

  if (node.type === "dir") {
    return (
      <div>
        <button
          className={`flex items-center gap-1 w-full text-left px-1 py-0.5 rounded text-xs hover:bg-accent transition-colors ${isSelected ? "bg-accent" : ""}`}
          style={{ paddingLeft: `${4 + depth * 12}px` }}
          onClick={toggleDir}
        >
          {loading ? (
            <Loader2 className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />
          ) : expanded ? (
            <>
              <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
              <FolderOpen className="w-3 h-3 shrink-0 text-amber-400" />
            </>
          ) : (
            <>
              <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
              <Folder className="w-3 h-3 shrink-0 text-amber-400" />
            </>
          )}
          <span className="truncate text-foreground">{node.name}</span>
        </button>
        {error && (
          <p className="text-[10px] text-destructive pl-8">{error}</p>
        )}
        {expanded && children && (
          <div>
            {children.map((child) => (
              <TreeNode
                key={child.path}
                sessionId={sessionId}
                node={child}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                depth={depth + 1}
                ownerToken={ownerToken}
              />
            ))}
            {children.length === 0 && (
              <p className="text-[10px] text-muted-foreground" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}>
                Empty
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      className={`flex items-center gap-1 w-full text-left px-1 py-0.5 rounded text-xs hover:bg-accent transition-colors ${isSelected ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      style={{ paddingLeft: `${4 + depth * 12}px` }}
      onClick={() => onSelectFile(node.path)}
    >
      <span className="w-3 h-3 shrink-0" />
      <File className="w-3 h-3 shrink-0 text-blue-400/80" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

interface FilesTabProps {
  sessionId: number;
  isActive: boolean;
  ownerToken: string | undefined;
}

export function FilesTab({ sessionId, isActive: _isActive, ownerToken }: FilesTabProps) {
  const { toast } = useToast();

  // localToken may be seeded from the prop but can also be supplied by the
  // inline token-entry form when the prop is absent (e.g. for older sessions
  // where the token was never written to sessionStorage).
  const [localToken, setLocalToken] = useState<string | undefined>(ownerToken);
  const [tokenInput, setTokenInput] = useState("");

  // Sync prop → local state when the parent value changes (e.g. after login).
  useEffect(() => {
    if (ownerToken && !localToken) setLocalToken(ownerToken);
  }, [ownerToken, localToken]);

  const handleTokenSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const t = tokenInput.trim();
    if (!t) return;
    // Persist so the parent component finds it on next render.
    try {
      sessionStorage.setItem(`nim-owner-token:${sessionId}`, t);
    } catch {
      // sessionStorage might be blocked in some browsers — continue without
    }
    setLocalToken(t);
    setTokenInput("");
  }, [tokenInput, sessionId]);

  const [rootEntries, setRootEntries] = useState<FileNode[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [editorValue, setEditorValue] = useState<string>("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const editorValueRef = useRef(editorValue);
  editorValueRef.current = editorValue;

  const loadRoot = useCallback(async () => {
    if (!localToken) return;
    setRootLoading(true);
    setRootError(null);
    try {
      const entries = await apiFetch<FileEntry[]>(
        `${BASE_URL}api/sessions/${sessionId}/files?path=/workspace&token=${encodeURIComponent(localToken)}`
      );
      setRootEntries(entries.map((e) => ({ ...e, path: `/workspace/${e.name}` })));
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to load /workspace");
    } finally {
      setRootLoading(false);
    }
  }, [sessionId, localToken]);

  useEffect(() => {
    if (localToken) loadRoot();
  }, [sessionId, localToken, loadRoot]);

  const openFile = useCallback(async (path: string) => {
    if (!localToken) return;
    setSelectedPath(path);
    setFileLoading(true);
    setFileError(null);
    setDirty(false);
    try {
      const { content } = await apiFetch<{ content: string }>(
        `${BASE_URL}api/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}&token=${encodeURIComponent(localToken)}`
      );
      setFileContent(content);
      setEditorValue(content);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setFileLoading(false);
    }
  }, [sessionId, localToken]);

  const saveFile = useCallback(async () => {
    if (!selectedPath || saving || !localToken) return;
    setSaving(true);
    try {
      await apiFetch(`${BASE_URL}api/sessions/${sessionId}/files/content`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localToken}`,
        },
        body: JSON.stringify({ path: selectedPath, content: editorValueRef.current }),
      });
      setFileContent(editorValueRef.current);
      setDirty(false);
      toast({ title: "File saved", description: selectedPath.split("/").pop() });
      // Refresh tree after save so any new/renamed files appear
      loadRoot();
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Could not save file",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [selectedPath, saving, sessionId, localToken, toast, loadRoot]);

  // Ctrl+S / Cmd+S save shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && selectedPath) {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveFile, selectedPath]);

  const handleEditorChange = useCallback((value: string) => {
    setEditorValue(value);
    setDirty(value !== fileContent);
  }, [fileContent]);

  const langExt = selectedPath ? getLanguageExtension(selectedPath.split("/").pop() ?? "") : null;

  return (
    <div className="flex h-full min-h-0 gap-0 overflow-hidden" style={{ height: "calc(100vh - 200px)", minHeight: "400px" }}>
      {/* File tree — left panel */}
      <div
        className="w-[200px] shrink-0 border-r border-border/40 flex flex-col overflow-hidden"
        style={{ background: "var(--bg-glass)" }}
      >
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/40 shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">/workspace</span>
          <button
            onClick={loadRoot}
            disabled={rootLoading}
            className="p-0.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            title="Refresh tree"
          >
            <RefreshCw className={`w-3 h-3 ${rootLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1 px-1 text-xs font-mono">
          {/* Token-entry fallback: shown when no owner token is available */}
          {!localToken && (
            <div className="flex flex-col gap-2 px-2 py-3">
              <div className="flex items-center gap-1 text-muted-foreground text-[11px]">
                <KeyRound className="w-3.5 h-3.5 shrink-0" />
                <span className="leading-tight">Owner token required to browse files</span>
              </div>
              <form onSubmit={handleTokenSubmit} className="flex flex-col gap-1.5">
                <Input
                  type="password"
                  placeholder="Paste owner token…"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  className="h-6 text-[11px] px-1.5"
                  autoComplete="off"
                />
                <Button type="submit" size="sm" variant="outline" className="h-6 text-[10px] px-2" disabled={!tokenInput.trim()}>
                  Unlock
                </Button>
              </form>
            </div>
          )}
          {localToken && rootLoading && (
            <div className="flex items-center gap-1.5 px-2 py-3 text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading...
            </div>
          )}
          {localToken && rootError && !rootLoading && (
            <div className="flex flex-col gap-1.5 px-2 py-3">
              <div className="flex items-center gap-1 text-destructive text-[11px]">
                <FolderX className="w-3.5 h-3.5 shrink-0" />
                <span className="leading-tight">{rootError}</span>
              </div>
              <button
                onClick={loadRoot}
                className="text-[10px] text-muted-foreground hover:text-foreground underline text-left"
              >
                Retry
              </button>
            </div>
          )}
          {localToken && !rootLoading && !rootError && rootEntries !== null && (
            rootEntries.length === 0 ? (
              <p className="text-[10px] text-muted-foreground px-2 py-3">Empty directory</p>
            ) : (
              rootEntries.map((node) => (
                <TreeNode
                  key={node.path}
                  sessionId={sessionId}
                  node={node}
                  selectedPath={selectedPath}
                  onSelectFile={openFile}
                  depth={0}
                  ownerToken={localToken}
                />
              ))
            )
          )}
        </div>
      </div>

      {/* Editor — right panel */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selectedPath ? (
          <>
            {/* Toolbar */}
            <div
              className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 shrink-0 gap-2"
              style={{ background: "var(--bg-glass)" }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <File className="w-3.5 h-3.5 shrink-0 text-blue-400/80" />
                <span className="text-xs font-mono truncate text-muted-foreground" title={selectedPath}>
                  {selectedPath}
                </span>
                {dirty && (
                  <span className="text-[10px] text-amber-400 shrink-0">● unsaved</span>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs px-2 shrink-0 gap-1"
                onClick={saveFile}
                disabled={saving || fileLoading || !dirty}
                title="Save (Ctrl+S)"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </Button>
            </div>

            {/* Editor body */}
            <div className="flex-1 overflow-auto min-h-0">
              {fileLoading && (
                <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading file...
                </div>
              )}
              {fileError && !fileLoading && (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm">
                  <AlertCircle className="w-5 h-5 text-destructive" />
                  <span className="text-destructive">{fileError}</span>
                  <button
                    onClick={() => openFile(selectedPath)}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Retry
                  </button>
                </div>
              )}
              {!fileLoading && !fileError && (
                <CodeMirror
                  value={editorValue}
                  onChange={handleEditorChange}
                  theme={oneDark}
                  extensions={langExt ? [langExt] : []}
                  height="100%"
                  style={{ fontSize: "12px", height: "100%" }}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightSelectionMatches: true,
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-6">
            <File className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Select a file from the tree to open it</p>
            <p className="text-[11px] text-muted-foreground/60">Changes are saved with Ctrl+S or the Save button</p>
          </div>
        )}
      </div>
    </div>
  );
}
