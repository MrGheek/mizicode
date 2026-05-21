import { pgTable, serial, text, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gpuProfilesTable } from "./gpu-profiles";
import { skillBundlesTable } from "./skills";
import { projectPlansTable } from "./project-plan";

export interface TeamMemberRecord {
  name: string;
  password: string;
  path: string;
  ideUrl: string | null;
}

export interface SessionRoutingStats {
  totalBytesAvoided: number;
  totalShielded: number;
  totalArtifacts: number;
  totalBlocked: number;
  routingFailures: number;
  recordedAt: string;
}

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull().references(() => gpuProfilesTable.id),
  provider: text("provider").notNull().default("vastai"),
  nimProvider: text("nim_provider"),
  nimModelId: text("nim_model_id"),
  vastInstanceId: integer("vast_instance_id"),
  vastOfferId: integer("vast_offer_id"),
  templateHash: text("template_hash"),
  status: text("status").notNull().default("pending"),
  statusMessage: text("status_message"),
  boltDiyUrl: text("bolt_diy_url"),
  codeServerUrl: text("code_server_url"),
  previewUrl: text("preview_url"),
  sshHost: text("ssh_host"),
  sshPort: integer("ssh_port"),
  publicIp: text("public_ip"),
  costPerHour: real("cost_per_hour"),
  totalCost: real("total_cost").default(0),
  gpuName: text("gpu_name"),
  numGpus: integer("num_gpus"),
  startedAt: timestamp("started_at"),
  stoppedAt: timestamp("stopped_at"),
  teamMembers: jsonb("team_members").$type<TeamMemberRecord[]>(),
  taskMode: text("task_mode"),
  tokenMode: text("token_mode"),
  activeBundleId: integer("active_bundle_id").references(() => skillBundlesTable.id),
  repoFingerprintJson: jsonb("repo_fingerprint_json"),
  // Plain-English description of what the user is trying to accomplish in this
  // session, captured at launch (e.g. "Add Stripe payments to checkout").
  // Seeded into memory and surfaced as the cockpit goal badge.
  intentText: text("intent_text"),
  routingStatsJson: jsonb("routing_stats_json").$type<SessionRoutingStats>(),
  swarmSnapshotJson: jsonb("swarm_snapshot_json"),
  // Plan progress snapshot pushed by the Claw Runner via POST /plan-push.
  // Shape: { activeTask, planCheckpoint, activeFiles, unresolvedErrors, updatedAt }
  planSnapshotJson: jsonb("plan_snapshot_json"),
  // Token issued at session creation time. Required to call session-owner actions
  // (e.g. swarm abort) from the dashboard. Not a team-member credential — the
  // owner token gates destructive controls that team members must not access.
  ownerToken: text("owner_token"),
  // Whether the session was launched with a GitHub PAT. The token itself is
  // never stored — it is passed only via the onstart script. This flag lets
  // the dashboard show the session branch chip (mizi/session-<id>).
  hasGithubToken: boolean("has_github_token").notNull().default(false),
  // Fly.io Machine ID for NIM sessions provisioned on Fly.io instead of Vast.ai.
  // Null for all Vast.ai GPU sessions.
  flyMachineId: text("fly_machine_id"),
  // nginx basic-auth credentials for bolt.diy / code-server on NIM sessions.
  // Generated at provisioning time and passed as NGINX_AUTH_USER / NGINX_AUTH_PASS
  // env vars into the Fly machine so the dashboard can display them.
  workspaceUser: text("workspace_user"),
  workspacePassword: text("workspace_password"),
  // Phase-aware inference routing (Task #300).
  // currentPhase: the active reasoning phase used for model selection scoring.
  // Valid values: explore | plan | implement | swarm | synthesise | review
  currentPhase: text("current_phase"),
  // The NIM model currently active for inference (may differ from nimModelId
  // after an automatic phase-triggered switch).
  activeNimModelId: text("active_nim_model_id"),
  // The provider currently serving the active model.
  activeNimProvider: text("active_nim_provider"),
  // "auto" = phase-aware routing enabled; "pinned" = user-locked model, no auto-switching.
  modelRoutingMode: text("model_routing_mode").default("auto"),
  // Project plan linked to this session (nullable — not all sessions have a plan).
  planId: integer("plan_id").references(() => projectPlansTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
