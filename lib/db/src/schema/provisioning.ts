import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

export const schemaTemplatesTable = pgTable("schema_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sqlContent: text("sql_content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const provisionedResourcesTable = pgTable("provisioned_resources", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessionsTable.id),
  type: text("type").notNull(),
  resourceId: text("resource_id"),
  connectionString: text("connection_string"),
  schemaTemplateId: integer("schema_template_id").references(
    () => schemaTemplatesTable.id
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
  deletedAt: timestamp("deleted_at"),
});

export type ProvisionedResource =
  typeof provisionedResourcesTable.$inferSelect;
export type SchemaTemplate = typeof schemaTemplatesTable.$inferSelect;
