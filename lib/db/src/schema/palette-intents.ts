import { pgTable, serial, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const paletteIntentsTable = pgTable("palette_intents", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("operator"),
  query: text("query").notNull(),
  ok: boolean("ok").notNull(),
  action: text("action"),
  payloadJson: jsonb("payload_json"),
  explanation: text("explanation").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PaletteIntent = typeof paletteIntentsTable.$inferSelect;
