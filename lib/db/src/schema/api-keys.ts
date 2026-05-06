import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ApiKey = typeof apiKeysTable.$inferSelect;
export type NewApiKey = typeof apiKeysTable.$inferInsert;
