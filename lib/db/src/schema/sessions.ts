import { pgTable, serial, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gpuProfilesTable } from "./gpu-profiles";

export interface TeamMemberRecord {
  name: string;
  password: string;
  path: string;
  ideUrl: string | null;
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
