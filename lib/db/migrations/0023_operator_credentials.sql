CREATE TABLE "operator_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"github_login" text,
	"github_avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
