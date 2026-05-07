import { useState, useEffect, useRef, useCallback } from "react";
import {
  FolderOpen,
  ArrowRight,
  Zap,
  PlusCircle,
  MinusCircle,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Users,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";
import type { LaneWithPolicy } from "@workspace/api-client-react";

export type LaneEventType =
  | "claim_created"
  | "claim_released"
  | "claim_expired"
  | "handoff_sent"
  | "handoff_acknowledged"
  | "heavy_job_started"
  | "heavy_job_completed"
  | "lane_created"
  | "lane_destroyed";

export interface LaneEventItem {
  id: number;
  sessionId: number;
  laneId: number;
  eventType: LaneEventType;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface TimelineApiResponse {
  laneId: number;
  events: LaneEventItem[];
  nextCursor: number | null;
  total: number;
}

const EVENT_ICONS: Record<LaneEventType, React.ReactNode> = {
  claim_created:        <PlusCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
  claim_released:       <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />,
  claim_expired:        <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
  handoff_sent:         <ArrowRight className="w-3.5 h-3.5 text-sky-400 shrink-0" />,
  handoff_acknowledged: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
  heavy_job_started:    <Zap className="w-3.5 h-3.5 text-violet-400 shrink-0" />,
  heavy_job_completed:  <Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
  lane_created:         <Users className="w-3.5 h-3.5 text-sky-400 shrink-0" />,
  lane_destroyed:       <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />,
};

const EVENT_LABELS: Record<LaneEventType, string> = {
  claim_created:        "Claim created",
  claim_released:       "Claim released",
  claim_expired:        "Claim expired",
  handoff_sent:         "Handoff sent",
  handoff_acknowledged: "Handoff acknowledged",
  heavy_job_started:    "Heavy job started",
  heavy_job_completed:  "Heavy job completed",
  lane_created:         "Lane created",
  lane_destroyed:       "Lane destroyed",
};

function eventDescription(event: LaneEventItem): string | null {
  const p = event.payload;
  if (!p) return null;
  switch (event.eventType) {
    case "claim_created":
    case "claim_released":
    case "claim_expired":
      return typeof p["resourcePath"] === "string" ? p["resourcePath"] : null;
    case "handoff_sent":
    case "handoff_acknowledged":
      return typeof p["handoffType"] === "string"
        ? p["handoffType"].replace(/_/g, " ")
        : null;
    case "heavy_job_started":
    case "heavy_job_completed":
      return typeof p["jobClass"] === "string"
        ? p["jobClass"].replace(/_/g, " ")
        : null;
    default:
      return null;
  }
}

function TimelineEventRow({ event }: { event: LaneEventItem }) {
  const icon = EVENT_ICONS[event.eventType] ?? <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
  const label = EVENT_LABELS[event.eventType] ?? event.eventType;
  const description = eventDescription(event);

  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-border/20 last:border-0">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground/90">{label}</p>
        {description && (
          <p className="text-[11px] font-mono text-muted-foreground truncate mt-0.5" title={description}>
            {description}
          </p>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5 whitespace-nowrap">
        {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
      </span>
    </div>
  );
}

const PAGE_SIZE = 25;

async function fetchTimeline(
  sessionId: number,
  laneId: number,
  cursor?: number,
): Promise<TimelineApiResponse> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor != null) params.set("cursor", String(cursor));
  const res = await fetch(
    `${BASE_URL}api/sessions/${sessionId}/lanes/${laneId}/timeline?${params}`,
  );
  if (!res.ok) throw new Error(`Timeline fetch failed: ${res.status}`);
  return res.json() as Promise<TimelineApiResponse>;
}

export function LaneTimeline({
  sessionId,
  lanes,
  incomingEvent,
}: {
  sessionId: number;
  lanes: LaneWithPolicy[];
  incomingEvent: LaneEventItem | null;
}) {
  const [selectedLaneId, setSelectedLaneId] = useState<string>(() =>
    lanes[0] ? String(lanes[0].id) : "",
  );

  const laneId = selectedLaneId ? Number(selectedLaneId) : null;
  const selectedLane = lanes.find((l) => l.id === laneId);

  const [events, setEvents] = useState<LaneEventItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInitial = useCallback(async (lid: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTimeline(sessionId, lid);
      setEvents(data.events);
      setNextCursor(data.nextCursor);
    } catch {
      setError("Failed to load timeline. Will retry on next refresh.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadMore = useCallback(async () => {
    if (!laneId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchTimeline(sessionId, laneId, nextCursor);
      setEvents((prev) => [...prev, ...data.events]);
      setNextCursor(data.nextCursor);
    } catch {
    } finally {
      setLoadingMore(false);
    }
  }, [sessionId, laneId, nextCursor, loadingMore]);

  useEffect(() => {
    if (laneId) {
      setEvents([]);
      setNextCursor(null);
      loadInitial(laneId);
    }
  }, [laneId, loadInitial]);

  const prevIncomingRef = useRef<LaneEventItem | null>(null);
  useEffect(() => {
    if (
      incomingEvent &&
      incomingEvent !== prevIncomingRef.current &&
      incomingEvent.laneId === laneId
    ) {
      prevIncomingRef.current = incomingEvent;
      setEvents((prev) => {
        if (prev.some((e) => e.id === incomingEvent.id)) return prev;
        return [incomingEvent, ...prev];
      });
    }
  }, [incomingEvent, laneId]);

  useEffect(() => {
    if (lanes.length > 0 && !selectedLaneId) {
      setSelectedLaneId(String(lanes[0]!.id));
    }
  }, [lanes, selectedLaneId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={selectedLaneId} onValueChange={setSelectedLaneId}>
          <SelectTrigger className="h-7 text-xs flex-1">
            <SelectValue placeholder="Select lane…" />
          </SelectTrigger>
          <SelectContent>
            {lanes.map((lane) => (
              <SelectItem key={lane.id} value={String(lane.id)} className="text-xs">
                {lane.memberIdentifier}{" "}
                <span className="text-muted-foreground capitalize ml-1">
                  ({lane.laneType})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {laneId && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="Refresh timeline"
            onClick={() => loadInitial(laneId)}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {selectedLane && (
        <p className="text-[10px] text-muted-foreground">
          <span className="capitalize font-medium">{selectedLane.memberIdentifier}</span>
          {" — "}
          <span className="capitalize">{selectedLane.laneType}</span> lane
          <Badge
            variant="outline"
            className="ml-2 text-[9px] px-1 py-0 bg-secondary/40 text-muted-foreground border-border/30"
          >
            {selectedLane.status}
          </Badge>
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground/60">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          <span className="text-xs">Loading timeline…</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2 text-xs text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && laneId && (
        <div className="py-8 text-center text-muted-foreground/50 text-xs">
          No events recorded for this lane yet.
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="space-y-0">
          {events.map((event) => (
            <TimelineEventRow key={event.id} event={event} />
          ))}
        </div>
      )}

      {nextCursor && !loading && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-7 text-xs text-muted-foreground"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          Load older events
        </Button>
      )}
    </div>
  );
}
