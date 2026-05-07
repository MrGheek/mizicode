import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Database, AlertCircle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL } from "@/lib/api-url";
import { format } from "date-fns";

interface SchemaTemplate {
  id: number;
  name: string;
  description: string;
  sqlContent: string;
  createdAt: string;
  updatedAt: string;
}

function useSchemaTemplates() {
  return useQuery<SchemaTemplate[]>({
    queryKey: ["schema-templates"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}api/schema-templates`);
      if (!res.ok) throw new Error("Failed to load schema templates");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
}

function TemplateRow({
  template,
  onDelete,
}: {
  template: SchemaTemplate;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <div
        className="glass-card p-4 space-y-2 cursor-pointer"
        style={{ borderRadius: 10 }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database className="w-4 h-4 shrink-0" style={{ color: "var(--accent-cyan)" }} />
            <div className="min-w-0">
              <p className="font-medium text-sm truncate" style={{ color: "var(--text-primary)" }}>
                {template.name}
              </p>
              {template.description && (
                <p className="text-xs truncate mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  {template.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
              {format(new Date(template.createdAt), "MMM d, yyyy")}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteOpen(true); }}
              className="p-1 rounded transition-colors hover:text-red-400"
              style={{ color: "var(--text-muted)" }}
              title="Delete template"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
              : <ChevronRight className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />}
          </div>
        </div>

        {expanded && (
          <div
            className="mt-3 rounded-lg overflow-x-auto"
            style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-glass)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <pre
              className="p-4 text-xs font-mono whitespace-pre leading-relaxed"
              style={{ color: "var(--text-secondary)", minWidth: 400 }}
            >
              {template.sqlContent}
            </pre>
          </div>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400" />
              Delete schema template
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to delete <strong>{template.name}</strong>?
            This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { setDeleteOpen(false); onDelete(template.id); }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NewTemplateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sqlContent, setSqlContent] = useState("");
  const { toast } = useToast();

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE_URL}api/schema-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), sqlContent: sqlContent.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Failed to create template");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Schema template created" });
      setName("");
      setDescription("");
      setSqlContent("");
      onCreated();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const valid = name.trim().length > 0 && sqlContent.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-4 h-4" style={{ color: "var(--accent-cyan)" }} />
            New schema template
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Name <span className="text-red-400">*</span>
            </label>
            <Input
              placeholder="e.g. E-commerce schema"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 100))}
              className="bg-secondary/30 border-border/50 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Description
            </label>
            <Input
              placeholder="Brief description of what this schema provides"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 500))}
              className="bg-secondary/30 border-border/50 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              SQL <span className="text-red-400">*</span>
            </label>
            <Textarea
              placeholder={`CREATE TABLE IF NOT EXISTS users (\n  id SERIAL PRIMARY KEY,\n  ...\n);`}
              value={sqlContent}
              onChange={(e) => setSqlContent(e.target.value)}
              className="bg-secondary/30 border-border/50 text-xs font-mono resize-none min-h-[200px]"
              rows={10}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => createMut.mutate()}
            disabled={!valid || createMut.isPending}
          >
            {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Create template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SchemaTemplatesPage() {
  const { data: templates, isLoading, isError } = useSchemaTemplates();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE_URL}api/schema-templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete template");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schema-templates"] });
      toast({ title: "Template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-xl font-semibold tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            Schema Templates
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Reusable SQL schema definitions. When an agent provisions a test
            database, it can reference a template here to get a pre-seeded schema
            instead of an empty database.
          </p>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => setNewOpen(true)}
          style={{
            background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-violet))",
            border: "none",
            color: "#fff",
          }}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          New Template
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
        </div>
      )}

      {isError && (
        <div className="glass-card p-4 flex items-center gap-3 text-sm">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span style={{ color: "var(--text-secondary)" }}>Failed to load schema templates.</span>
        </div>
      )}

      {!isLoading && !isError && templates && (
        <div className="space-y-2">
          {templates.length === 0 && (
            <div
              className="py-16 text-center rounded-xl"
              style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}
            >
              <Database
                className="w-8 h-8 mx-auto mb-3 opacity-20"
                style={{ color: "var(--text-secondary)" }}
              />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No schema templates yet.
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Create one to let agents provision pre-seeded test databases.
              </p>
            </div>
          )}
          {templates.map((t) => (
            <TemplateRow key={t.id} template={t} onDelete={(id) => deleteMut.mutate(id)} />
          ))}
        </div>
      )}

      <div
        className="glass-card p-4 text-xs space-y-2 rounded-xl"
        style={{ border: "1px solid var(--border-glass)" }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">API</Badge>
          <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
            Agent usage
          </span>
        </div>
        <p style={{ color: "var(--text-muted)" }}>
          Agents can provision a database with a template using the{" "}
          <code
            className="px-1 py-0.5 rounded text-[11px]"
            style={{ background: "var(--bg-glass-hover)", color: "var(--accent-cyan)" }}
          >
            provision_test_db
          </code>{" "}
          tool:
        </p>
        <pre
          className="p-3 rounded-lg text-[11px] leading-relaxed font-mono overflow-x-auto"
          style={{ background: "rgba(0,0,0,0.3)", color: "var(--text-secondary)" }}
        >
          {`provision_test_db({ type: "postgres", schemaTemplate: <template_id> })`}
        </pre>
      </div>

      <NewTemplateDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["schema-templates"] })}
      />
    </div>
  );
}
