/**
 * Lightweight typed event emitter for project plan lifecycle events.
 *
 * Emits: plan.created | plan.updated | plan.task_status_changed | plan.reassessed
 *
 * plan.created  — first time a plan is generated for a userId+repo pair.
 * plan.updated  — an existing plan is regenerated (new draft on same planId).
 *
 * Future connectors (Slack, Linear, Jira) can subscribe here without
 * touching core plan logic.
 */
import { EventEmitter } from "events";

export interface PlanCreatedEvent {
  planId: number;
  userId: string;
  repoUrl: string | null;
  title: string;
  taskCount: number;
}

export interface PlanTaskStatusChangedEvent {
  taskId: number;
  planId: number;
  userId: string;
  previousStatus: string;
  newStatus: string;
  confirmedByUser: boolean;
}

export interface PlanReassessedEvent {
  planId: number;
  sessionId: number;
  userId: string;
  summary: string;
  updatedTaskCount: number;
}

export interface PlanDecomposedEvent {
  planId: number;
  sessionId: string;
  userId: string;
  newTaskCount: number;
  planVersion: number;
}

export type PlanEvent =
  | { type: "plan.created"; payload: PlanCreatedEvent }
  | { type: "plan.updated"; payload: PlanCreatedEvent }
  | { type: "plan.task_status_changed"; payload: PlanTaskStatusChangedEvent }
  | { type: "plan.reassessed"; payload: PlanReassessedEvent }
  | { type: "plan.decomposed"; payload: PlanDecomposedEvent };

class PlanEventEmitter extends EventEmitter {
  emit_plan(event: PlanEvent): void {
    this.emit(event.type, event.payload);
    this.emit("*", event);
  }

  on_plan(eventType: PlanEvent["type"] | "*", listener: (payload: PlanEvent["payload"]) => void): this {
    return this.on(eventType, listener);
  }
}

export const planEvents = new PlanEventEmitter();
planEvents.setMaxListeners(50);
