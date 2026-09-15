/**
 * use-factory.ts — RFC 0005: typed data-access layer for /factory/* endpoints.
 *
 * Factory is not in the OpenAPI spec, so there is no generated client. Follows
 * the dashboard's raw-fetch convention (schema-templates.tsx / intelligence.tsx)
 * with namespaced TanStack Query keys and operator bearer auth.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/lib/api-url";
import type {
  FactoryProduct,
  FactoryWorkOrder,
  FactoryStation,
  FactoryDashboard,
  FactoryMetric,
  ArbitrationPass,
  FabStatus,
  ProductPriority,
} from "@/lib/factory-types";

const OPERATOR_TOKEN_LS_KEY = "mizi.ambient.operatorToken";

export function getOperatorToken(): string {
  try { return localStorage.getItem(OPERATOR_TOKEN_LS_KEY) ?? ""; } catch { return ""; }
}

export function factoryAuthHeaders(): Record<string, string> {
  const tok = getOperatorToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function factoryFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}api${path}`, {
    ...init,
    headers: { ...factoryAuthHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body as { error?: string } | null)?.error ?? `Factory request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const factoryKeys = {
  all: ["factory"] as const,
  fab: () => ["factory", "fab"] as const,
  products: () => ["factory", "products"] as const,
  product: (id: number) => ["factory", "product", id] as const,
  workOrders: (id: number) => ["factory", "product", id, "work-orders"] as const,
  stations: (id: number) => ["factory", "product", id, "stations"] as const,
  dashboard: (id: number) => ["factory", "product", id, "dashboard"] as const,
  metrics: (id: number) => ["factory", "product", id, "metrics"] as const,
  arbitration: (id: number) => ["factory", "product", id, "arbitration"] as const,
  arbitrationLatest: () => ["factory", "arbitration", "latest"] as const,
};

// ── Queries ────────────────────────────────────────────────────────────────────

export function useFabStatus() {
  return useQuery<FabStatus>({
    queryKey: factoryKeys.fab(),
    queryFn: () => factoryFetch<FabStatus>("/factory/fab/status"),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useFactoryProducts() {
  return useQuery<{ products: FactoryProduct[]; total: number }>({
    queryKey: factoryKeys.products(),
    queryFn: () => factoryFetch("/factory/products"),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useFactoryProduct(id: number | null | undefined) {
  return useQuery<{ product: FactoryProduct }>({
    queryKey: factoryKeys.product(id ?? 0),
    queryFn: () => factoryFetch(`/factory/products/${id}`),
    enabled: id != null && Number.isFinite(id),
    refetchOnWindowFocus: false,
  });
}

export function useFactoryWorkOrders(productId: number | null | undefined) {
  return useQuery<{ productId: number; workOrders: FactoryWorkOrder[]; total: number }>({
    queryKey: factoryKeys.workOrders(productId ?? 0),
    queryFn: () => factoryFetch(`/factory/products/${productId}/work-orders`),
    enabled: productId != null && Number.isFinite(productId),
    refetchOnWindowFocus: false,
  });
}

export function useFactoryStations(productId: number | null | undefined) {
  return useQuery<{ productId: number; stations: FactoryStation[]; total: number }>({
    queryKey: factoryKeys.stations(productId ?? 0),
    queryFn: () => factoryFetch(`/factory/products/${productId}/stations`),
    enabled: productId != null && Number.isFinite(productId),
    refetchOnWindowFocus: false,
  });
}

export function useFactoryDashboard(productId: number | null | undefined) {
  return useQuery<FactoryDashboard>({
    queryKey: factoryKeys.dashboard(productId ?? 0),
    queryFn: () => factoryFetch<FactoryDashboard>(`/factory/products/${productId}/dashboard`),
    enabled: productId != null && Number.isFinite(productId),
    refetchOnWindowFocus: false,
  });
}

export function useFactoryMetrics(productId: number | null | undefined, limit = 50) {
  return useQuery<{ productId: number; total: number; metrics: FactoryMetric[] }>({
    queryKey: [...factoryKeys.metrics(productId ?? 0), limit],
    queryFn: () => factoryFetch(`/factory/products/${productId}/metrics?limit=${limit}`),
    enabled: productId != null && Number.isFinite(productId),
    refetchOnWindowFocus: false,
  });
}

export function useFactoryArbitration(productId: number | null | undefined) {
  return useQuery<{ passId: number; ranAt: string; lines: ArbitrationPass["lines"]; starvationSignals: ArbitrationPass["starvationSignals"]; lanePool: ArbitrationPass["lanePool"] }>({
    queryKey: factoryKeys.arbitration(productId ?? 0),
    queryFn: () => factoryFetch(`/factory/products/${productId}/arbitration`),
    enabled: productId != null && Number.isFinite(productId),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useLatestArbitration() {
  return useQuery<{ pass: ArbitrationPass }>({
    queryKey: factoryKeys.arbitrationLatest(),
    queryFn: () => factoryFetch("/factory/arbitration/latest"),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function useRunDispatch(productId?: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (productId != null) {
        return factoryFetch(`/factory/products/${productId}/dispatch`, { method: "POST" });
      }
      return factoryFetch<{ pass: ArbitrationPass }>("/factory/dispatch", { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}

export function useCreateFactoryProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      name: string;
      repoUrl: string;
      priority?: ProductPriority;
      dueDate?: string | null;
      budgetUsd?: number | null;
      wipLimit?: number;
    }) =>
      factoryFetch<{ product: FactoryProduct }>("/factory/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}

export function useUpdateFactoryProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: number;
      priority?: ProductPriority;
      dueDate?: string | null;
      budgetUsd?: number | null;
      wipLimit?: number;
    }) =>
      factoryFetch<{ product: FactoryProduct }>(`/factory/products/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priority: params.priority,
          dueDate: params.dueDate,
          budgetUsd: params.budgetUsd,
          wipLimit: params.wipLimit,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}

export function useDecomposeProduct(productId: number | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { intentText: string; commit?: boolean }) =>
      factoryFetch<{ ok: boolean; planId: number; roadmap: string[]; committedWorkOrderIds?: number[]; llmFailed?: boolean }>(
        `/factory/products/${productId}/decompose`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, commit: params.commit ?? false }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}

export function useReleaseClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (claimId: number) =>
      factoryFetch<{ ok: boolean; claimId: number; requeuedWorkOrders: number[]; sessionId: number }>(
        `/factory/claims/${claimId}/release`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}

export function useCompleteWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { workOrderId: number; status?: "done" | "skipped" }) =>
      factoryFetch(`/factory/work-orders/${params.workOrderId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: params.status ?? "done" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
}
