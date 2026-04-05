import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gpuProfilesTable } from "./gpu-profiles";

export const volumesTable = pgTable("volumes", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").references(() => gpuProfilesTable.id),
  vastVolumeId: integer("vast_volume_id"),
  // machineId is the Vast.ai physical host the volume lives on.
  // Volumes are machine-local — future sessions must run on this machine to mount the volume.
  machineId: integer("machine_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("pending"),
  sizeGb: integer("size_gb").notNull(),
  statusMessage: text("status_message"),
  provisioningInstanceId: integer("provisioning_instance_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertVolumeSchema = createInsertSchema(volumesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVolume = z.infer<typeof insertVolumeSchema>;
export type Volume = typeof volumesTable.$inferSelect;
