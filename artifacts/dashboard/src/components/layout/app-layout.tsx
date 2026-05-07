import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Home, Terminal, Brain, Settings, Bot, Layers, KeyRound,
  CheckCircle2, Bell, ChevronDown, ChevronRight, X,
  CheckCircle, XCircle, AlertTriangle, DatabaseZap,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useHealthCheck,
  useGetActiveSession,
  useDeleteSession,
  useGetSchedulerConfig,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import { StopCountdownModal } from "@/components/stop-countdown-modal";
import { CommandPalette } from "@/components/command-palette";
import { NotificationWatchers } from "@/components/notification-watchers";
import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL } from "@/lib/api-url";
import { useMemoryReviewCount } from "@/pages/memory";
import { formatDistanceToNow } from "date-fns";

interface SafetyAction {
  id: number;
  kind: string;
  summary: string;
  classification: string;
  status: string;
  scope: string;
  reversible: boolean;
  externalSurface: boolean;
  createdAt: number;
}

const OPERATOR_TOKEN_LS_KEY = "mizi.ambient.operatorToken";
function getOperatorToken(): string {
  try { return localStorage.getItem(OPERATOR_TOKEN_LS_KEY) ?? ""; } catch { return ""; }
}
function authHeaders(): Record<string, string> {
  const tok = getOperatorToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function ApprovalSlideOut({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();

  const { data: pending } = useQuery<{ actions: SafetyAction[] }>({
    queryKey: ["safety-pending-slideout"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE_URL}api/dashboard/safety/pending`);
      if (!r.ok) return { actions: [] };
      return r.json();
    },
    refetchInterval: 5000,
    enabled: open,
  });

  const decideAction = useMutation({
    mutationFn: async ({ id, decision }: { id: number; decision: "approve" | "deny" }) => {
      const r = await fetch(`${API_BASE_URL}api/safety/actions/${id}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decidedBy: "operator" }),
      });
      if (!r.ok) throw new Error("Action failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["safety-pending-slideout"] });
      qc.invalidateQueries({ queryKey: ["safety-pending-nav"] });
    },
  });

  if (!open) return null;

  const actions = pending?.actions ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-stretch pointer-events-none">
      <div className="flex-1 pointer-events-auto" onClick={onClose} />
      <div
        className="w-96 pointer-events-auto flex flex-col glass-emerge"
        style={{
          background: "rgba(10,10,20,0.96)",
          borderLeft: "1px solid var(--border-glass)",
          backdropFilter: "blur(24px)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4" style={{ color: "var(--accent-cyan)" }} />
            <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Pending Approvals</span>
            {actions.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(251,191,36,0.2)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}>
                {actions.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: "var(--text-secondary)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {actions.length === 0 ? (
            <div className="text-center py-12 text-sm" style={{ color: "var(--text-secondary)" }}>
              <CheckCircle2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
              <p>No pending approvals</p>
            </div>
          ) : (
            actions.map((a) => (
              <div key={a.id} className="glass-card p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{ background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}>
                        {a.kind}
                      </span>
                      {!a.reversible && <span className="text-[10px] text-red-400">irreversible</span>}
                    </div>
                    <p className="text-xs" style={{ color: "var(--text-primary)" }}>{a.summary}</p>
                    <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
                      {formatDistanceToNow(a.createdAt * 1000, { addSuffix: true })}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => decideAction.mutate({ id: a.id, decision: "approve" })}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs font-medium transition-colors"
                    style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981" }}
                  >
                    <CheckCircle className="w-3 h-3" /> Approve
                  </button>
                  <button
                    onClick={() => decideAction.mutate({ id: a.id, decision: "deny" })}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs font-medium transition-colors"
                    style={{ background: "rgba(244,63,94,0.08)", border: "1px solid rgba(244,63,94,0.2)", color: "#f43f5e" }}
                  >
                    <XCircle className="w-3 h-3" /> Deny
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 text-xs" style={{ borderTop: "1px solid var(--border-glass)", color: "var(--text-muted)" }}>
          Full controls in{" "}
          <Link href="/ambient" className="underline" style={{ color: "var(--text-secondary)" }}>
            Platform → Ambient
          </Link>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  badge,
  active,
  indent = false,
  collapsed = false,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  badge?: number;
  active: boolean;
  indent?: boolean;
  collapsed?: boolean;
}) {
  return (
    <Link href={href}>
      <div
        title={collapsed ? label : undefined}
        className={`flex items-center gap-3 py-2 rounded-xl cursor-pointer transition-all text-sm relative group ${indent && !collapsed ? "ml-3" : ""} ${collapsed ? "justify-center px-0" : "px-3"}`}
        style={
          active
            ? {
                background: "var(--nav-active-bg)",
                color: "var(--text-primary)",
                fontWeight: 500,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.55)",
              }
            : { color: "var(--text-secondary)", fontWeight: 400 }
        }
        onMouseEnter={(e) => {
          if (!active) {
            (e.currentTarget as HTMLElement).style.background = "var(--nav-hover-bg)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            (e.currentTarget as HTMLElement).style.background = "";
            (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
          }
        }}
      >
        {/* Active left-edge indicator */}
        {active && !collapsed && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full"
            style={{ background: "var(--accent-cyan)", opacity: 0.65 }}
          />
        )}
        {active && collapsed && (
          <span
            className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 rounded-full"
            style={{ background: "var(--accent-cyan)", opacity: 0.65 }}
          />
        )}
        <Icon className="w-4 h-4 shrink-0" style={{ opacity: active ? 1 : 0.6 }} />
        {!collapsed && <span className="flex-1">{label}</span>}
        {!collapsed && badge !== undefined && badge > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"
            style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.22)" }}>
            {badge}
          </span>
        )}
        {collapsed && badge !== undefined && badge > 0 && (
          <span
            className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
            style={{ background: "#fbbf24" }}
          />
        )}
      </div>
    </Link>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();
  const { data: reviewCount } = useMemoryReviewCount();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [platformOpen, setPlatformOpen] = useState(() => {
    const platformPaths = ["/ambient", "/templates", "/api-keys", "/settings"];
    return platformPaths.some((p) => location === p || location.startsWith(p));
  });
  const [approvalOpen, setApprovalOpen] = useState(false);

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

  const { data: pendingApprovals } = useQuery<{ actions: Array<{ id: number }> }>({
    queryKey: ["safety-pending-nav"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE_URL}api/dashboard/safety/pending`);
      if (!r.ok) return { actions: [] };
      return r.json();
    },
    refetchInterval: 10000,
  });
  const ambientBadge = pendingApprovals?.actions?.length ?? 0;
  const memoryBadge = reviewCount?.total ?? 0;

  const platformPages = [
    { name: "Ambient", href: "/ambient", icon: Bot, badge: ambientBadge },
    { name: "Templates", href: "/templates", icon: Layers },
    { name: "Schema Templates", href: "/schema-templates", icon: DatabaseZap },
    { name: "API Keys", href: "/api-keys", icon: KeyRound },
    { name: "Settings", href: "/settings", icon: Settings },
  ];

  const isPlatformActive = platformPages.some(
    (p) => location === p.href || location.startsWith(p.href)
  );

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location === href || location.startsWith(href);

  const systemHealthOk = health?.status === "ok";

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-base)" }}>

      {/* ── SIDEBAR — frosted floating rail, collapsed by default ── */}
      <aside
        className="flex flex-col shrink-0 transition-all duration-300"
        style={{
          width: sidebarCollapsed ? "52px" : "224px",
          background: "var(--sidebar-bg)",
          borderRight: "1px solid var(--border-glass-soft)",
          backdropFilter: "blur(48px) saturate(180%)",
          WebkitBackdropFilter: "blur(48px) saturate(180%)",
          overflow: "hidden",
        }}
      >
        {/* Wordmark / toggle */}
        <div
          className="flex items-center cursor-pointer select-none shrink-0"
          style={{
            borderBottom: "1px solid var(--border-glass-ultra)",
            padding: sidebarCollapsed ? "18px 0" : "18px 20px",
            justifyContent: sidebarCollapsed ? "center" : "flex-start",
            gap: sidebarCollapsed ? 0 : "12px",
          }}
          onClick={() => setSidebarCollapsed(v => !v)}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <div
            className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0 text-white text-xs font-semibold"
            style={{
              background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-violet))",
              boxShadow: "0 2px 8px rgba(0,180,216,0.25), inset 0 1px 0 rgba(255,255,255,0.18)",
            }}
          >
            M
          </div>
          {!sidebarCollapsed && (
            <div className="min-w-0 overflow-hidden">
              <p className="font-semibold text-sm tracking-tight whitespace-nowrap" style={{ color: "var(--text-primary)" }}>MIZI</p>
              <p className="text-[10px] font-mono tracking-widest uppercase whitespace-nowrap" style={{ color: "var(--accent-cyan)", opacity: 0.7 }}>Code</p>
            </div>
          )}
        </div>

        {/* Main nav */}
        <nav
          className="flex-1 py-4 space-y-0.5 overflow-y-auto overflow-x-hidden"
          style={{ padding: sidebarCollapsed ? "16px 6px" : "16px 10px" }}
        >
          <NavItem href="/" icon={Home} label="Home" active={isActive("/")} collapsed={sidebarCollapsed} />
          <NavItem href="/sessions" icon={Terminal} label="Sessions" active={isActive("/sessions")} collapsed={sidebarCollapsed} />
          <NavItem
            href="/intelligence"
            icon={Brain}
            label="Intelligence"
            badge={memoryBadge}
            active={isActive("/intelligence")}
            collapsed={sidebarCollapsed}
          />

          {/* Divider */}
          <div className="my-3 mx-1 h-px" style={{ background: "var(--border-glass-ultra)" }} />

          {/* Platform group — icon only when collapsed */}
          {sidebarCollapsed ? (
            <NavItem
              href="/settings"
              icon={Settings}
              label="Platform"
              badge={ambientBadge}
              active={isPlatformActive}
              collapsed
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPlatformOpen((v) => !v)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-all text-sm"
                style={{
                  color: isPlatformActive ? "var(--text-primary)" : "var(--text-secondary)",
                  background: isPlatformActive ? "var(--nav-active-bg)" : undefined,
                  fontWeight: isPlatformActive ? 500 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!isPlatformActive) {
                    (e.currentTarget as HTMLElement).style.background = "var(--nav-hover-bg)";
                    (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isPlatformActive) {
                    (e.currentTarget as HTMLElement).style.background = "";
                    (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
                  }
                }}
              >
                <Settings className="w-4 h-4 shrink-0" style={{ opacity: isPlatformActive ? 1 : 0.6 }} />
                <span className="flex-1 text-left">Platform</span>
                {ambientBadge > 0 && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full mr-0.5"
                    style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.22)" }}>
                    {ambientBadge}
                  </span>
                )}
                {platformOpen
                  ? <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-40" />
                  : <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-40" />
                }
              </button>

              {platformOpen && (
                <div className="mt-0.5 space-y-0.5 glass-emerge">
                  {platformPages.map((item) => (
                    <NavItem
                      key={item.name}
                      href={item.href}
                      icon={item.icon}
                      label={item.name}
                      badge={item.badge}
                      active={isActive(item.href)}
                      indent
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </nav>

        {/* Sidebar footer */}
        <div
          className="py-3 space-y-0.5 shrink-0"
          style={{
            borderTop: "1px solid var(--border-glass-ultra)",
            padding: sidebarCollapsed ? "12px 6px" : "12px 10px",
          }}
        >
          <button
            type="button"
            onClick={() => setApprovalOpen((v) => !v)}
            title={sidebarCollapsed ? "Notifications" : undefined}
            className="w-full flex items-center gap-3 py-2 rounded-xl transition-all text-sm relative"
            style={{
              color: "var(--text-secondary)",
              fontWeight: 400,
              justifyContent: sidebarCollapsed ? "center" : "flex-start",
              padding: sidebarCollapsed ? "8px 0" : "8px 12px",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--nav-hover-bg)";
              (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "";
              (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
            }}
          >
            <Bell className="w-4 h-4 shrink-0 opacity-60" />
            {!sidebarCollapsed && <span className="flex-1 text-left">Notifications</span>}
            {!sidebarCollapsed && ambientBadge > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.22)" }}>
                {ambientBadge}
              </span>
            )}
            {sidebarCollapsed && ambientBadge > 0 && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full" style={{ background: "#fbbf24" }} />
            )}
          </button>

          <div
            className="flex items-center gap-2 py-1.5"
            style={{
              color: "var(--text-muted)",
              justifyContent: sidebarCollapsed ? "center" : "flex-start",
              padding: sidebarCollapsed ? "6px 0" : "6px 12px",
            }}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${systemHealthOk ? "bg-emerald-500" : "bg-amber-400"}`}
              style={{ opacity: 0.8 }}
            />
            {!sidebarCollapsed && (
              <span className="font-mono text-[11px] tracking-tight whitespace-nowrap">
                {systemHealthOk ? "System healthy" : "API unreachable"}
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT ───────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto focus:outline-none" style={{ background: "var(--bg-base)" }}>
        {children}
      </main>

      {/* Approval slide-out */}
      <ApprovalSlideOut open={approvalOpen} onClose={() => setApprovalOpen(false)} />

      {/* Global notification watchers */}
      <NotificationWatchers />

      {/* Global stop countdown modal */}
      <StopCountdownModal
        schedulerConfig={schedulerConfig}
        activeSession={activeSession}
        onStop={handleScheduledStop}
      />

      {/* Global command palette */}
      <CommandPalette />
    </div>
  );
}
