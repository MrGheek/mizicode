import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { gpuProfilesTable } from "./gpu-profiles";

export const schedulerConfigTable = pgTable("scheduler_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  profileId: integer("profile_id").references(() => gpuProfilesTable.id),
  launchTime: text("launch_time").notNull().default("09:00"),
  stopTime: text("stop_time").notNull().default("19:00"),
  secondReminderTime: text("second_reminder_time").notNull().default("00:00"),
  daysOfWeek: text("days_of_week")
    .array()
    .notNull()
    .default(sql`ARRAY['mon','tue','wed','thu','fri']::text[]`),
  timezone: text("timezone").notNull().default("America/New_York"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
