import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const nimCatalogTable = pgTable("nim_catalog", {
  nimModelId: text("nim_model_id").primaryKey(),
  displayName: text("display_name").notNull(),
  nimTypes: jsonb("nim_types").$type<string[]>().notNull().default([]),
  partnerProviders: jsonb("partner_providers").$type<string[]>().notNull().default([]),
  shortDescription: text("short_description"),
  usecaseTags: jsonb("usecase_tags").$type<string[]>().notNull().default([]),
  contextLength: text("context_length"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
});

export type NimCatalogEntry = typeof nimCatalogTable.$inferSelect;
export type InsertNimCatalogEntry = typeof nimCatalogTable.$inferInsert;
