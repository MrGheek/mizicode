import { pgTable, serial, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gpuProfilesTable } from "./gpu-profiles";
import { skillBundlesTable } from "./skills";

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
  routingStatsJson: jsonb("routing_stats_json").$type<SessionRoutingStats>(),
  swarmSnapshotJson: jsonb("swarm_snapshot_json"),
  // Token issued at session creation time. Required to call session-owner actions
  // (e.g. swarm abort) from the dashboard. Not a team-member credential — the
  // owner token gates destructive controls that team members must not access.
  ownerToken: text("owner_token"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
