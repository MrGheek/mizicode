import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const operatorCredentialsTable = pgTable("operator_credentials", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  githubLogin: text("github_login"),
  githubAvatarUrl: text("github_avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("operator_credentials_provider_unique").on(t.provider)]);

export type OperatorCredential = typeof operatorCredentialsTable.$inferSelect;
export type NewOperatorCredential = typeof operatorCredentialsTable.$inferInsert;
