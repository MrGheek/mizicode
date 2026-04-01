import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gpuProfilesTable } from "./gpu-profiles";

export const templatesTable = pgTable("templates", {
  id: serial("id").primaryKey(),
  templateHash: text("template_hash").notNull(),
  name: text("name").notNull(),
  image: text("image").notNull(),
  onStartScript: text("on_start_script"),
  envVars: text("env_vars"),
  isDefault: boolean("is_default").notNull().default(false),
  profileId: integer("profile_id").references(() => gpuProfilesTable.id),
  diskSpace: integer("disk_space"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTemplateSchema = createInsertSchema(templatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type Template = typeof templatesTable.$inferSelect;
