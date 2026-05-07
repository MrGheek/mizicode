import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL } from "@/lib/api-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Lock,
  Layers,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface LaneTypeEntry {
  id: number | null;
  name: string;
  description: string;
  maxConcurrentClaims: number;
  heavyJobSlots: number;
  isBuiltin: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface LaneTypesResponse {
  builtins: LaneTypeEntry[];
  custom: LaneTypeEntry[];
  all: LaneTypeEntry[];
}

const OPERATOR_TOKEN_LS_KEY = "mizi.ambient.operatorToken";
function getOperatorToken(): string {
  try { return localStorage.getItem(OPERATOR_TOKEN_LS_KEY) ?? ""; } catch { return ""; }
}
function getAuthHeaders(): Record<string, string> {
  const tok = getOperatorToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function fetchLaneTypes(): Promise<LaneTypesResponse> {
  const res = await fetch(`${API_BASE_URL}api/coordination/lane-types`);
  if (!res.ok) throw new Error("Failed to fetch lane types");
  return res.json() as Promise<LaneTypesResponse>;
}

async function createLaneType(data: {
  name: string;
  description: string;
  maxConcurrentClaims: number;
  heavyJobSlots: number;
}): Promise<LaneTypeEntry> {
  const res = await fetch(`${API_BASE_URL}api/coordination/lane-types`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to create lane type");
  }
  return res.json() as Promise<LaneTypeEntry>;
}

async function updateLaneType(
  id: number,
  data: { description?: string; maxConcurrentClaims?: number; heavyJobSlots?: number },
): Promise<LaneTypeEntry> {
  const res = await fetch(`${API_BASE_URL}api/coordination/lane-types/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to update lane type");
  }
  return res.json() as Promise<LaneTypeEntry>;
}

async function deleteLaneType(id: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}api/coordination/lane-types/${id}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to delete lane type");
  }
}

const LANE_NAME_RE = /^[a-z][a-z0-9_-]{0,49}$/;

function LaneTypeForm({
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel,
  nameEditable,
}: {
  initialValues?: { name: string; description: string; maxConcurrentClaims: number; heavyJobSlots: number };
  onSubmit: (values: { name: string; description: string; maxConcurrentClaims: number; heavyJobSlots: number }) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitLabel: string;
  nameEditable: boolean;
}) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [maxConcurrentClaims, setMaxConcurrentClaims] = useState(initialValues?.maxConcurrentClaims ?? 20);
  const [heavyJobSlots, setHeavyJobSlots] = useState(initialValues?.heavyJobSlots ?? 2);
  const [nameError, setNameError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (nameEditable) {
      if (!name.trim() || !LANE_NAME_RE.test(name.trim())) {
        setNameError("Name must start with a lowercase letter, then lowercase letters, numbers, hyphens, or underscores (max 50 chars)");
        return;
      }
    }
    onSubmit({ name: name.trim(), description: description.trim(), maxConcurrentClaims, heavyJobSlots });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {nameEditable && (
        <div className="space-y-1.5">
          <Label htmlFor="lane-type-name" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Name
          </Label>
          <Input
            id="lane-type-name"
            value={name}
            onChange={(e) => { setName(e.target.value.toLowerCase()); setNameError(null); }}
            placeholder="e.g. ml, infra, data, security"
            className="h-8 text-sm font-mono"
            maxLength={50}
            autoFocus
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          <p className="text-[10px] text-muted-foreground">
            Lowercase letters, numbers, hyphens, underscores — used as the lane type identifier.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="lane-type-description" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Description <span className="font-normal normal-case tracking-normal opacity-60">(optional)</span>
        </Label>
        <Textarea
          id="lane-type-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this lane type for?"
          className="text-xs resize-none h-16"
          maxLength={300}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="lane-type-max-claims" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Max Concurrent Claims
          </Label>
          <Input
            id="lane-type-max-claims"
            type="number"
            min={1}
            max={500}
            value={maxConcurrentClaims}
            onChange={(e) => setMaxConcurrentClaims(Math.max(1, parseInt(e.target.value) || 1))}
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Max simultaneous file/resource claims.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lane-type-heavy-slots" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Heavy Job Slots
          </Label>
          <Input
            id="lane-type-heavy-slots"
            type="number"
            min={1}
            max={50}
            value={heavyJobSlots}
            onChange={(e) => setHeavyJobSlots(Math.max(1, parseInt(e.target.value) || 1))}
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Slots for indexing, embedding, etc.</p>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-7 text-xs gap-1" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function BuiltinRow({ entry }: { entry: LaneTypeEntry }) {
  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-md bg-secondary/20 border border-border/30">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold capitalize text-foreground">{entry.name}</span>
          <Badge variant="outline" className="text-[9px] px-1 py-0 gap-0.5 text-muted-foreground border-border/50">
            <Lock className="w-2 h-2" /> built-in
          </Badge>
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate" title={entry.description}>
            {entry.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[10px] text-muted-foreground/70">
            {entry.maxConcurrentClaims} claims · {entry.heavyJobSlots} heavy slots
          </span>
        </div>
      </div>
    </div>
  );
}

function CustomRow({
  entry,
  onEdit,
  onDelete,
  isDeleting,
}: {
  entry: LaneTypeEntry;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-md border border-border/50 bg-card/30">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground">{entry.name}</span>
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-primary/10 text-primary/80 border-primary/20">
            custom
          </Badge>
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate" title={entry.description}>
            {entry.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[10px] text-muted-foreground/70">
            {entry.maxConcurrentClaims} claims · {entry.heavyJobSlots} heavy slots
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onEdit}
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Edit lane type"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
          title="Delete lane type"
        >
          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

export function LaneTypesPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<LaneTypeEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery<LaneTypesResponse>({
    queryKey: ["lane-types"],
    queryFn: fetchLaneTypes,
    refetchInterval: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: createLaneType,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lane-types"] });
      setCreateOpen(false);
      toast({ title: "Lane type created" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create lane type", description: err.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateLaneType>[1] }) =>
      updateLaneType(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lane-types"] });
      setEditTarget(null);
      toast({ title: "Lane type updated" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to update lane type", description: err.message });
    },
  });

  const handleDelete = async (entry: LaneTypeEntry) => {
    if (entry.id === null) return;
    setDeletingId(entry.id);
    try {
      await deleteLaneType(entry.id);
      queryClient.invalidateQueries({ queryKey: ["lane-types"] });
      toast({ title: `Lane type '${entry.name}' deleted` });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Cannot delete lane type",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const builtins = data?.builtins ?? [];
  const customs = data?.custom ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Lane Types</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Built-in types are read-only. Create custom types for specialized team topologies (ML, Infra, Security, etc.).
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 shrink-0"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="w-3 h-3" /> New type
        </Button>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading lane types…
        </div>
      )}
      {isError && !isLoading && (
        <p className="text-xs text-destructive py-2">Failed to load lane types. Check API connectivity.</p>
      )}

      {!isLoading && !isError && (
        <div className="space-y-4">
          {/* Built-in types */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Built-in ({builtins.length})
            </p>
            <div className="space-y-1">
              {builtins.map((entry) => (
                <BuiltinRow key={entry.name} entry={entry} />
              ))}
            </div>
          </div>

          {/* Custom types */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Custom ({customs.length})
            </p>
            {customs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-1">
                No custom lane types yet. Click "New type" to create one.
              </p>
            ) : (
              <div className="space-y-1">
                {customs.map((entry) => (
                  <CustomRow
                    key={entry.id}
                    entry={entry}
                    onEdit={() => setEditTarget(entry)}
                    onDelete={() => handleDelete(entry)}
                    isDeleting={deletingId === entry.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Lane Type
            </DialogTitle>
          </DialogHeader>
          <LaneTypeForm
            nameEditable
            submitLabel="Create"
            isSubmitting={createMutation.isPending}
            onCancel={() => setCreateOpen(false)}
            onSubmit={(values) => createMutation.mutate(values)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Pencil className="w-4 h-4" /> Edit Lane Type: {editTarget?.name}
            </DialogTitle>
          </DialogHeader>
          {editTarget && (
            <LaneTypeForm
              nameEditable={false}
              submitLabel="Save changes"
              isSubmitting={updateMutation.isPending}
              initialValues={editTarget as { name: string; description: string; maxConcurrentClaims: number; heavyJobSlots: number }}
              onCancel={() => setEditTarget(null)}
              onSubmit={(values) => {
                if (editTarget.id === null) return;
                updateMutation.mutate({
                  id: editTarget.id,
                  data: {
                    description: values.description,
                    maxConcurrentClaims: values.maxConcurrentClaims,
                    heavyJobSlots: values.heavyJobSlots,
                  },
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
