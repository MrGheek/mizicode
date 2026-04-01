import { useState } from "react";
import { 
  useListTemplates, 
  useCreateTemplate, 
  useUpdateTemplate, 
  useDeleteTemplate,
  getListTemplatesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Layers, Plus, Trash2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export default function Templates() {
  const { data: templates, isLoading } = useListTemplates();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createTemplate = useCreateTemplate();
  const deleteTemplate = useDeleteTemplate();
  // const updateTemplate = useUpdateTemplate(); // if needed for editing

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formData, setFormData] = useState({ name: "", image: "", onStartScript: "", envVars: "" });

  const handleCreate = () => {
    createTemplate.mutate({ data: formData }, {
      onSuccess: () => {
        toast({ title: "Template Created" });
        setIsCreateOpen(false);
        setFormData({ name: "", image: "", onStartScript: "", envVars: "" });
        queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to create", description: err.error, variant: "destructive" });
      }
    });
  };

  const handleDelete = (id: number) => {
    if(!confirm("Delete template?")) return;
    deleteTemplate.mutate({ templateId: id }, {
      onSuccess: () => {
        toast({ title: "Template Deleted" });
        queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err.error, variant: "destructive" });
      }
    });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground mt-1">Manage Vast.ai docker templates and scripts</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" /> New Template
        </Button>
      </div>

      <div className="border border-border/50 rounded-lg bg-card/50 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50 bg-secondary/20">
              <TableHead>Name</TableHead>
              <TableHead>Hash</TableHead>
              <TableHead>Docker Image</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : templates?.length ? (
              templates.map((tpl) => (
                <TableRow key={tpl.id} className="border-border/50">
                  <TableCell className="font-medium">{tpl.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[150px]">
                    {tpl.templateHash}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-primary/80">
                    {tpl.image}
                  </TableCell>
                  <TableCell>
                    {tpl.isDefault ? (
                      <Badge variant="default" className="bg-primary/20 text-primary border-primary/30">Default</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">Custom</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleDelete(tpl.id)}
                      disabled={tpl.isDefault}
                      title={tpl.isDefault ? "Cannot delete default template" : "Delete"}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  <Layers className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  No templates configured
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="bg-card border-border sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create Template</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input 
                value={formData.name} 
                onChange={e => setFormData({...formData, name: e.target.value})} 
                placeholder="e.g. Ubuntu CUDA 12.1" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Docker Image</label>
              <Input 
                value={formData.image} 
                onChange={e => setFormData({...formData, image: e.target.value})} 
                placeholder="e.g. pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">On-start Script (Optional)</label>
              <Input 
                value={formData.onStartScript} 
                onChange={e => setFormData({...formData, onStartScript: e.target.value})} 
                placeholder="e.g. pip install -r requirements.txt" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Env Vars (Optional)</label>
              <Input 
                value={formData.envVars} 
                onChange={e => setFormData({...formData, envVars: e.target.value})} 
                placeholder="e.g. PORT=8080,NODE_ENV=production" 
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!formData.name || !formData.image || createTemplate.isPending}>
              {createTemplate.isPending ? "Creating..." : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
