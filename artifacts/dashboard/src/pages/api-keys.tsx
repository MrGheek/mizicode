import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Trash2, Copy, Check, Loader2, ShieldCheck, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL } from "@/lib/api-url";

interface ApiKey {
  id: number;
  label: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface ListKeysResponse {
  keys: ApiKey[];
}

interface CreateKeyResponse {
  id: number;
  key: string;
  label: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
}

const QUERY_KEY = ["api-keys"];

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (k: ApiKey) => void }) {
  return (
    <div className="flex items-start gap-4 py-4 border-b border-border/40 last:border-0">
      <div className="pt-0.5 shrink-0">
        <Key className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{apiKey.label}</span>
          {apiKey.scopes.length > 0
            ? apiKey.scopes.map((s) => (
                <Badge key={s} variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                  {s}
                </Badge>
              ))
            : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  all scopes
                </Badge>
              )}
        </div>
        <div className="flex gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
          <span>Created {formatDateRelative(apiKey.createdAt)}</span>
          <span>Last used: {formatDate(apiKey.lastUsedAt)}</span>
          {apiKey.expiresAt && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Expires {formatDate(apiKey.expiresAt)}
            </span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
        onClick={() => onRevoke(apiKey)}
      >
        <Trash2 className="w-3.5 h-3.5 mr-1" />
        Revoke
      </Button>
    </div>
  );
}

const AVAILABLE_SCOPES = ["agent", "memory", "sessions", "templates", "skills", "admin"];

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreateKeyResponse) => void;
}) {
  const [label, setLabel] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const body: { label: string; scopes: string[]; expiresAt?: string } = {
        label: label.trim(),
        scopes: selectedScopes,
      };
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();

      const r = await fetch(`${API_BASE_URL}api/auth/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? "Failed to create API key");
      }
      return r.json() as Promise<CreateKeyResponse>;
    },
    onSuccess: (data) => {
      onCreated(data);
      setLabel("");
      setSelectedScopes([]);
      setExpiresAt("");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleClose = () => {
    if (mutation.isPending) return;
    setLabel("");
    setSelectedScopes([]);
    setExpiresAt("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Create API Key
          </DialogTitle>
          <DialogDescription>
            The plaintext key value will be shown once and cannot be retrieved again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="key-label">Label</Label>
            <Input
              id="key-label"
              placeholder="e.g. CI pipeline, local dev"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Scopes <span className="text-muted-foreground font-normal">(leave blank for all)</span></Label>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_SCOPES.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => toggleScope(scope)}
                  disabled={mutation.isPending}
                  className={`text-xs font-mono px-2 py-0.5 rounded border transition-colors ${
                    selectedScopes.includes(scope)
                      ? "bg-primary/20 border-primary/50 text-primary"
                      : "bg-secondary/40 border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                  }`}
                >
                  {scope}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="key-expires">
              Expiry <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="key-expires"
              type="date"
              value={expiresAt}
              min={new Date().toISOString().split("T")[0]}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={mutation.isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!label.trim() || mutation.isPending}
          >
            {mutation.isPending ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Creating…</>
            ) : (
              <><Plus className="w-3.5 h-3.5 mr-1.5" />Create Key</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewKeyRevealDialog({
  result,
  onClose,
}: {
  result: CreateKeyResponse | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Dialog open={!!result} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="w-4 h-4 text-primary" />
            API Key Created
          </DialogTitle>
          <DialogDescription>
            Copy this key now — it will <strong>not</strong> be shown again.
          </DialogDescription>
        </DialogHeader>

        {result && (
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Label</p>
              <p className="text-sm font-medium">{result.label}</p>
            </div>
            {result.scopes.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Scopes</p>
                <div className="flex gap-1 flex-wrap">
                  {result.scopes.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px] font-mono px-1.5 py-0">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Key</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-secondary/60 rounded px-3 py-2 font-mono break-all leading-relaxed">
                  {result.key}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeConfirmDialog({
  apiKey,
  onClose,
  onConfirm,
  isPending,
}: {
  apiKey: ApiKey | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!apiKey} onOpenChange={(v) => !v && !isPending && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke API Key</DialogTitle>
          <DialogDescription>
            {apiKey && (
              <>
                Revoke <strong>{apiKey.label}</strong>? This cannot be undone — any service using this key will lose access immediately.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Revoking…</>
            ) : (
              <><Trash2 className="w-3.5 h-3.5 mr-1.5" />Revoke</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState<CreateKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const { data, isLoading, isError } = useQuery<ListKeysResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const r = await fetch(`${API_BASE_URL}api/auth/keys`);
      if (!r.ok) throw new Error("Failed to load API keys");
      return r.json();
    },
    refetchInterval: 30000,
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API_BASE_URL}api/auth/keys/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? "Failed to revoke key");
      }
    },
    onSuccess: () => {
      toast({ title: "Key revoked", description: `"${revokeTarget?.label}" has been revoked.` });
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleCreated = (result: CreateKeyResponse) => {
    setShowCreate(false);
    setNewKeyResult(result);
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  const keys = data?.keys ?? [];

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage machine-to-machine API keys for programmatic access.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="shrink-0">
          <Plus className="w-4 h-4 mr-1.5" />
          Create Key
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Active Keys
            {!isLoading && (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {keys.length} {keys.length === 1 ? "key" : "keys"}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading keys…
            </div>
          ) : isError ? (
            <div className="py-8 text-center text-sm text-destructive">
              Failed to load API keys. Check that the API server is running.
            </div>
          ) : keys.length === 0 ? (
            <div className="py-10 text-center space-y-2">
              <Key className="w-8 h-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground">No active API keys.</p>
              <p className="text-xs text-muted-foreground/70">
                Create a key to allow programmatic access to the API.
              </p>
            </div>
          ) : (
            <div>
              {keys.map((k) => (
                <KeyRow key={k.id} apiKey={k} onRevoke={setRevokeTarget} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateKeyDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={handleCreated}
      />

      <NewKeyRevealDialog
        result={newKeyResult}
        onClose={() => setNewKeyResult(null)}
      />

      <RevokeConfirmDialog
        apiKey={revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
        isPending={revokeMutation.isPending}
      />
    </div>
  );
}
