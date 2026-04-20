import React from "react";
import { Link, useLocation } from "wouter";
import { Terminal, LayoutDashboard, Database, Layers, CheckCircle2, AlertCircle, Brain } from "lucide-react";
import {
  useHealthCheck,
  useGetActiveSession,
  useDeleteSession,
  useGetSchedulerConfig,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StopCountdownModal } from "@/components/stop-countdown-modal";
import { useToast } from "@/hooks/use-toast";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: activeSessionResp } = useGetActiveSession({
    query: { refetchInterval: 15000, queryKey: getGetActiveSessionQueryKey() }
  });
  const { data: schedulerConfig } = useGetSchedulerConfig();
  const deleteSession = useDeleteSession();

  const activeSession = activeSessionResp?.session ?? null;

  const handleScheduledStop = () => {
    if (!activeSession) return;
    deleteSession.mutate({ sessionId: activeSession.id }, {
      onSuccess: () => {
        toast({ title: "Session auto-stopped", description: "Scheduled stop time reached." });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to stop session", variant: "destructive" });
      },
    });
  };

  const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "Sessions", href: "/sessions", icon: Terminal },
    { name: "Templates", href: "/templates", icon: Layers },
    { name: "Memory", href: "/memory", icon: Brain },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <div className="w-64 border-r border-border flex flex-col bg-card">
        <div className="p-6 flex items-center gap-3 border-b border-border">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none">OmniQL</h1>
            <p className="text-[10px] uppercase tracking-widest text-primary font-mono font-bold">Cloud Coding</p>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${
                  isActive
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border bg-card/50">
          <div className="flex items-center gap-2 text-xs font-mono">
            {health?.status === "ok" ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 text-destructive" />
            )}
            <span className={health?.status === "ok" ? "text-muted-foreground" : "text-destructive"}>
              API: {health?.status || "disconnected"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-background focus:outline-none">
        {children}
      </main>

      {/* Global stop countdown modal — appears anywhere in the app */}
      <StopCountdownModal
        schedulerConfig={schedulerConfig}
        activeSession={activeSession}
        onStop={handleScheduledStop}
      />
    </div>
  );
}
