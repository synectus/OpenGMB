-- pg_trgm must exist before the trigram indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."audit_surface" AS ENUM('ui', 'mcp', 'worker', 'cli');--> statement-breakpoint
CREATE TYPE "public"."google_notification_type" AS ENUM('NEW_REVIEW', 'UPDATED_REVIEW', 'GOOGLE_UPDATE');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'manager', 'client_approver', 'client_viewer');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."profile_change_set_status" AS ENUM('draft', 'pending_approval', 'approved', 'queued', 'applied', 'partially_applied', 'failed', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."review_reply_status" AS ENUM('draft', 'pending_approval', 'approved', 'published', 'failed', 'blocked', 'deleted', 'superseded', 'conflict');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"prompt" text NOT NULL,
	"mentioned" boolean NOT NULL,
	"position" smallint,
	"competitors" text[] NOT NULL,
	"source_domains" text[] NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"data_source" text NOT NULL,
	"prompt_count" smallint NOT NULL,
	"provider_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"charged_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_settings" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"engines" text[] NOT NULL,
	"last_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY['read','write']::text[] NOT NULL,
	"mode" text DEFAULT 'human_in_the_loop' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_checkpoints" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_id" bigint NOT NULL,
	"last_hash" text NOT NULL,
	"row_count" bigint NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_type" text NOT NULL,
	"surface" "audit_surface" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" IN ('user', 'api_token', 'system'))
);
--> statement-breakpoint
CREATE TABLE "citation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"site_key" text,
	"custom_name" text,
	"custom_url" text,
	"status" text DEFAULT 'not_started' NOT NULL,
	"listing_url" text,
	"email_used" text,
	"name_used" text,
	"address_used" text,
	"phone_used" text,
	"submitted_on" date,
	"notes" text,
	"checked_at" timestamp with time zone,
	"check_result" text,
	"check_detail" jsonb,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "citation_entries_site_or_custom_check" CHECK (("citation_entries"."site_key" IS NOT NULL AND "citation_entries"."custom_name" IS NULL AND "citation_entries"."custom_url" IS NULL) OR ("citation_entries"."site_key" IS NULL AND "citation_entries"."custom_name" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "competitor_profile_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"place_id" text NOT NULL,
	"title" text,
	"kind" text NOT NULL,
	"data_source" text NOT NULL,
	"task_ref" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"fetched_on" date NOT NULL,
	"provider_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"charged_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"place_id" text NOT NULL,
	"title" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_on" date NOT NULL,
	"data_source" text NOT NULL,
	"categories" jsonb DEFAULT '{"primary":null,"additional":[],"ids":[]}'::jsonb NOT NULL,
	"total_photos" integer,
	"last_post_at" timestamp with time zone,
	"posts_count" integer,
	"rating" numeric(3, 1),
	"review_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_media_scans" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_media_seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"media_name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "customer_media_seen_location_media_unique" UNIQUE("location_id","media_name")
);
--> statement-breakpoint
CREATE TABLE "error_events" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_alerted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_api_calls" (
	"day" date NOT NULL,
	"method" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "google_api_calls_day_method_pk" PRIMARY KEY("day","method")
);
--> statement-breakpoint
CREATE TABLE "google_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"google_account_id" text NOT NULL,
	"google_account_email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_connections_org_id_google_account_id_unique" UNIQUE("org_id","google_account_id")
);
--> statement-breakpoint
CREATE TABLE "google_idempotency_keys" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_idempotency_keys_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "google_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"google_media_name" text NOT NULL,
	"category" text,
	"description" text,
	"google_url" text NOT NULL,
	"thumbnail_url" text,
	"width_pixels" integer,
	"height_pixels" integer,
	"google_created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_media_google_media_name_unique" UNIQUE("google_media_name")
);
--> statement-breakpoint
CREATE TABLE "google_notification_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid,
	"account_name" text NOT NULL,
	"topic" text,
	"registered_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "google_notification_registrations_account_name_unique" UNIQUE("account_name")
);
--> statement-breakpoint
CREATE TABLE "google_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"pubsub_message_id" text NOT NULL,
	"type" "google_notification_type" NOT NULL,
	"resource_name" text,
	"location_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"publish_time" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "google_notifications_pubsub_message_id_unique" UNIQUE("pubsub_message_id")
);
--> statement-breakpoint
CREATE TABLE "google_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"google_post_name" text NOT NULL,
	"topic_type" text NOT NULL,
	"state" text,
	"summary" text DEFAULT '' NOT NULL,
	"event_title" text,
	"media_url" text,
	"search_url" text,
	"cta_type" text,
	"cta_url" text,
	"google_created_at" timestamp with time zone,
	"google_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_posts_google_post_name_unique" UNIQUE("google_post_name")
);
--> statement-breakpoint
CREATE TABLE "google_rate_windows" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "google_rate_windows_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE TABLE "grid_competitor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"run_id" uuid,
	"keyword" text NOT NULL,
	"place_id" text NOT NULL,
	"title" text NOT NULL,
	"address" text,
	"snapshot_date" date NOT NULL,
	"data_source" text NOT NULL,
	"appearances" integer NOT NULL,
	"avg_rank" numeric(6, 2) NOT NULL,
	"best_rank" integer NOT NULL,
	"rating" numeric(3, 1),
	"review_count" integer,
	"category" text,
	"additional_categories" text[],
	"category_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text DEFAULT 'tracker' NOT NULL,
	"location_id" uuid,
	"keywords" text[] NOT NULL,
	"favorite_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"grid_size" smallint NOT NULL,
	"radius_m" integer NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"target_name" text NOT NULL,
	"target_place_id" text,
	"target_domain" text,
	"driver_id" text NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	"competitor_refresh" text DEFAULT 'manual' NOT NULL,
	"competitor_refreshed_at" timestamp with time zone,
	"competitor_skipped_no_place_id" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_configs_grid_size_check" CHECK (("grid_configs"."kind" = 'keyword_rank' AND "grid_configs"."grid_size" = 1) OR ("grid_configs"."kind" <> 'keyword_rank' AND "grid_configs"."grid_size" BETWEEN 3 AND 13 AND "grid_configs"."grid_size" % 2 = 1)),
	CONSTRAINT "grid_configs_radius_check" CHECK ("grid_configs"."radius_m" > 0),
	CONSTRAINT "grid_configs_kind_location_check" CHECK (("grid_configs"."kind" <> 'quick_scan') = ("grid_configs"."location_id" IS NOT NULL)),
	CONSTRAINT "grid_configs_quick_scan_manual_check" CHECK ("grid_configs"."kind" <> 'quick_scan' OR "grid_configs"."schedule" = 'manual')
);
--> statement-breakpoint
CREATE TABLE "grid_points" (
	"run_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"row" smallint NOT NULL,
	"col" smallint NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"rank" integer,
	"organic_rank" integer,
	"organic_url" text,
	"top3" boolean DEFAULT false NOT NULL,
	"competitors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "grid_points_run_id_row_col_pk" PRIMARY KEY("run_id","row","col")
);
--> statement-breakpoint
CREATE TABLE "grid_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"driver_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"byo" boolean DEFAULT false NOT NULL,
	"speed" text DEFAULT 'standard' NOT NULL,
	"cost_estimate_usd" numeric(12, 4) NOT NULL,
	"cost_charged_usd" numeric(12, 4),
	"data_source" text DEFAULT 'fixture' NOT NULL,
	"provider_estimate_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"provider_cost_usd" numeric(12, 4),
	"error" text,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"row" smallint NOT NULL,
	"col" smallint NOT NULL,
	"task_ref" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "healthcheck_skips" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"skipped_by" text,
	"skipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "healthcheck_skips_location_id_check_id_pk" PRIMARY KEY("location_id","check_id")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"note" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "limit_counters" (
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_counters_scope_kind_period_pk" PRIMARY KEY("scope","kind","period")
);
--> statement-breakpoint
CREATE TABLE "location_auto_revert" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" boolean DEFAULT false NOT NULL,
	"phone" boolean DEFAULT false NOT NULL,
	"address" boolean DEFAULT false NOT NULL,
	"enabled_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_data_access" (
	"location_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"org_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_data_access_location_id_resource_pk" PRIMARY KEY("location_id","resource")
);
--> statement-breakpoint
CREATE TABLE "location_group_members" (
	"group_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "location_group_members_group_id_location_id_pk" PRIMARY KEY("group_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "location_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_groups_workspace_id_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "location_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"requested_by" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_pages_slug_unique" UNIQUE("slug"),
	CONSTRAINT "location_pages_location_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "location_write_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"result" jsonb,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone,
	"batch_id" uuid
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"google_location_id" text,
	"google_account_name" text,
	"connection_id" uuid,
	"title" text,
	"phone" text,
	"address_summary" text,
	"status" text DEFAULT 'active' NOT NULL,
	"imported_at" timestamp with time zone,
	"center_lat" double precision,
	"center_lng" double precision,
	"center_source" text,
	"center_address_hash" text,
	"center_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"preview" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"result" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_user_workspace_unique" UNIQUE NULLS NOT DISTINCT("org_id","user_id","workspace_id"),
	CONSTRAINT "memberships_workspace_iff_client_role" CHECK (("memberships"."workspace_id" IS NOT NULL) = ("memberships"."role" IN ('client_approver', 'client_viewer')))
);
--> statement-breakpoint
CREATE TABLE "monitor_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_digests" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"digest_date" date NOT NULL,
	"status" text NOT NULL,
	"notification_count" integer NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_digests_org_id_user_id_digest_date_pk" PRIMARY KEY("org_id","user_id","digest_date")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"link" text,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_user_source_unique" UNIQUE("user_id","source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE "org_branding" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"agency_name" text,
	"logo_url" text,
	"primary_color" text,
	"accent_color" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "org_branding_primary_hex" CHECK ("org_branding"."primary_color" IS NULL OR "org_branding"."primary_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "org_branding_accent_hex" CHECK ("org_branding"."accent_color" IS NULL OR "org_branding"."accent_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "org_branding_logo_https" CHECK ("org_branding"."logo_url" IS NULL OR "org_branding"."logo_url" LIKE 'https://%')
);
--> statement-breakpoint
CREATE TABLE "org_dataforseo_credentials" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"password_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_grid_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"monthly_budget_usd" numeric(12, 2) NOT NULL,
	"markup_percent" numeric(6, 2) NOT NULL,
	"default_speed" text DEFAULT 'standard' NOT NULL,
	"default_competitor_refresh" text DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"health_report_seen_at" timestamp with time zone,
	"setup_dismissed_at" timestamp with time zone,
	"ai_disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_daily" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"date" date NOT NULL,
	"metric" text NOT NULL,
	"value" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performance_daily_location_id_date_metric_pk" PRIMARY KEY("location_id","date","metric")
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"backfilled_at" timestamp with time zone NOT NULL,
	"last_snapshot_date" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_dfs_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid,
	"cost_usd" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_surface" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"cta" jsonb,
	"event" jsonb,
	"offer" jsonb,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed_fields" text[] NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"guardrail_result" jsonb,
	"warnings_acknowledged" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_edits_post_revision_unique" UNIQUE("post_id","revision")
);
--> statement-breakpoint
CREATE TABLE "post_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"credit_name" text,
	"credit_url" text,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_images_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"occurrence" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"google_post_name" text,
	"published_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_targets_post_location_occurrence_unique" UNIQUE("post_id","location_id","occurrence")
);
--> statement-breakpoint
CREATE TABLE "post_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"topic_type" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"cta" jsonb,
	"event_title" text,
	"offer" jsonb,
	"image_id" uuid,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_templates_workspace_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_surface" text NOT NULL,
	"topic_type" text NOT NULL,
	"alert_type" text,
	"summary" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"cta" jsonb,
	"event" jsonb,
	"offer" jsonb,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"recurrence" jsonb,
	"occurrence" integer DEFAULT 0 NOT NULL,
	"guardrail_result" jsonb,
	"warnings_acknowledged" boolean DEFAULT false NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"scheduled_by" text,
	"scheduled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_surface" text NOT NULL,
	"status" "profile_change_set_status" DEFAULT 'draft' NOT NULL,
	"fields" jsonb NOT NULL,
	"update_mask" text[] DEFAULT '{}'::text[] NOT NULL,
	"guardrail_result" jsonb,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"applied_requested_by" text,
	"applied_requested_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_change_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_set_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_change_targets_set_location_unique" UNIQUE("change_set_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "profile_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"field_paths" text[] NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"google_suggested" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"revert_change_set_id" uuid
);
--> statement-breakpoint
CREATE TABLE "profile_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reply_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"generic" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_templates_workspace_id_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'performance' NOT NULL,
	"scope" text NOT NULL,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"group_id" uuid,
	"period" text NOT NULL,
	"custom_from" date,
	"custom_to" date,
	"schedule" text DEFAULT 'none' NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"comment" text,
	"ai_summary" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"pdf" "bytea",
	"pdf_bytes" integer,
	"content" jsonb,
	"summary" text,
	"summary_status" text,
	"error" text,
	"requested_by" text,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_run_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"assignee_user_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_assignments_review_id_unique" UNIQUE("review_id")
);
--> statement-breakpoint
CREATE TABLE "review_auto_drafts" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reply_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_link_clicks" (
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "review_link_clicks_link_id_day_source_pk" PRIMARY KEY("link_id","day","source")
);
--> statement-breakpoint
CREATE TABLE "review_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"google_place_id" text NOT NULL,
	"widget_enabled" boolean DEFAULT false NOT NULL,
	"widget_min_rating" smallint DEFAULT 4 NOT NULL,
	"widget_layout" text DEFAULT 'grid' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_links_slug_unique" UNIQUE("slug"),
	CONSTRAINT "review_links_location_unique" UNIQUE("location_id"),
	CONSTRAINT "review_links_min_rating_check" CHECK ("review_links"."widget_min_rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "review_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"status" "review_reply_status" DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_surface" text NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"publish_requested_by" text,
	"publish_requested_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"failure_reason" text,
	"base_reply_comment" text,
	"base_reply_update_time" timestamp with time zone,
	"conflict_google_comment" text,
	"conflict_google_update_time" timestamp with time zone,
	"conflict_detected_at" timestamp with time zone,
	"guardrail_result" jsonb,
	"warnings_acknowledged" boolean DEFAULT false NOT NULL,
	"auto_approved_min_stars" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_replies_review_revision_unique" UNIQUE("review_id","revision")
);
--> statement-breakpoint
CREATE TABLE "review_request_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"reminder_enabled" boolean DEFAULT true NOT NULL,
	"reminder_days" smallint DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_request_campaigns_reminder_days_check" CHECK ("review_request_campaigns"."reminder_days" between 1 and 14)
);
--> statement-breakpoint
CREATE TABLE "review_request_optouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_request_optouts_ws_email_unique" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
CREATE TABLE "review_request_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"link_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"reminder_attempts" integer DEFAULT 0 NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"reminder_failed_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"click_count" integer DEFAULT 0 NOT NULL,
	"opted_out_at" timestamp with time zone,
	"list_source" text,
	"list_confirmed_by" text,
	"list_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_request_recipients_campaign_email_unique" UNIQUE("campaign_id","email"),
	CONSTRAINT "review_request_recipients_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
CREATE TABLE "review_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_topics" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text NOT NULL,
	"overall_sentiment" text,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"text_hash" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"google_review_name" text NOT NULL,
	"reviewer_display_name" text,
	"reviewer_is_anonymous" boolean DEFAULT false NOT NULL,
	"star_rating" smallint,
	"comment" text,
	"create_time" timestamp with time zone NOT NULL,
	"update_time" timestamp with time zone NOT NULL,
	"reply_comment" text,
	"reply_update_time" timestamp with time zone,
	"reply_state" text,
	"reply_policy_violation" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_google_review_name_unique" UNIQUE("google_review_name")
);
--> statement-breakpoint
CREATE TABLE "search_keywords_monthly" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"month" date NOT NULL,
	"keyword" text NOT NULL,
	"value" integer,
	"threshold" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_keywords_monthly_location_id_month_keyword_pk" PRIMARY KEY("location_id","month","keyword"),
	CONSTRAINT "search_keywords_monthly_value_or_threshold" CHECK (num_nonnulls("search_keywords_monthly"."value", "search_keywords_monthly"."threshold") = 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspension_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"appeal_submitted_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"outcome_notes" text,
	"evidence_checklist" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"ai_notice_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret_enc" text NOT NULL,
	"description" text,
	"created_by_user_id" text NOT NULL,
	"api_token_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_ai_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"banned_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"sign_off" text DEFAULT '' NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"monthly_cap_micro_usd" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "workspace_reply_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"profile" text DEFAULT 'general' NOT NULL,
	"packs" text[] DEFAULT '{}'::text[] NOT NULL,
	"skip_positive_reviews" boolean DEFAULT false NOT NULL,
	"generic_templates_only" boolean DEFAULT false NOT NULL,
	"staff_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_approve_min_stars" smallint,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"auto_approve_enabled_by" text,
	"auto_approve_enabled_at" timestamp with time zone,
	"h2_severity" text DEFAULT 'block' NOT NULL,
	"draft_on_arrival" boolean DEFAULT false NOT NULL,
	"draft_on_arrival_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "workspace_reply_settings_auto_approve_min_stars_check" CHECK ("workspace_reply_settings"."auto_approve_min_stars" IS NULL OR "workspace_reply_settings"."auto_approve_min_stars" IN (4, 5)),
	CONSTRAINT "workspace_reply_settings_h2_severity_check" CHECK ("workspace_reply_settings"."h2_severity" IN ('block', 'warn'))
);
--> statement-breakpoint
CREATE TABLE "workspace_review_topic_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"auto_classify" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_post_language" text DEFAULT 'en' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"time_zone_source" text DEFAULT 'default' NOT NULL,
	"date_format" text DEFAULT 'YYYY-MM-DD' NOT NULL,
	"date_format_source" text DEFAULT 'default' NOT NULL,
	"sender_legal_name" text,
	"sender_postal_address" text,
	"sender_company_number" text,
	"sender_phone" text,
	"sender_website" text,
	"hipaa_covered_entity" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_id_name_unique" UNIQUE("org_id","name")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_results" ADD CONSTRAINT "ai_visibility_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_results" ADD CONSTRAINT "ai_visibility_results_run_id_ai_visibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_visibility_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_settings" ADD CONSTRAINT "ai_visibility_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_settings" ADD CONSTRAINT "ai_visibility_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_settings" ADD CONSTRAINT "ai_visibility_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_entries" ADD CONSTRAINT "citation_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_entries" ADD CONSTRAINT "citation_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_entries" ADD CONSTRAINT "citation_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_entries" ADD CONSTRAINT "citation_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_profile_tasks" ADD CONSTRAINT "competitor_profile_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_profiles" ADD CONSTRAINT "competitor_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_scans" ADD CONSTRAINT "customer_media_scans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_scans" ADD CONSTRAINT "customer_media_scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_seen" ADD CONSTRAINT "customer_media_seen_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_seen" ADD CONSTRAINT "customer_media_seen_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_idempotency_keys" ADD CONSTRAINT "google_idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_media" ADD CONSTRAINT "google_media_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_media" ADD CONSTRAINT "google_media_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_notification_registrations" ADD CONSTRAINT "google_notification_registrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_notification_registrations" ADD CONSTRAINT "google_notification_registrations_connection_id_google_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_notifications" ADD CONSTRAINT "google_notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_notifications" ADD CONSTRAINT "google_notifications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_posts" ADD CONSTRAINT "google_posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_posts" ADD CONSTRAINT "google_posts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_competitor_snapshots" ADD CONSTRAINT "grid_competitor_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_competitor_snapshots" ADD CONSTRAINT "grid_competitor_snapshots_config_id_grid_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."grid_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_competitor_snapshots" ADD CONSTRAINT "grid_competitor_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_competitor_snapshots" ADD CONSTRAINT "grid_competitor_snapshots_run_id_grid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grid_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD CONSTRAINT "grid_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD CONSTRAINT "grid_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD CONSTRAINT "grid_configs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD CONSTRAINT "grid_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_points" ADD CONSTRAINT "grid_points_run_id_grid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grid_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_points" ADD CONSTRAINT "grid_points_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_runs" ADD CONSTRAINT "grid_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_runs" ADD CONSTRAINT "grid_runs_config_id_grid_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."grid_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_runs" ADD CONSTRAINT "grid_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tasks" ADD CONSTRAINT "grid_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tasks" ADD CONSTRAINT "grid_tasks_run_id_grid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grid_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthcheck_skips" ADD CONSTRAINT "healthcheck_skips_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthcheck_skips" ADD CONSTRAINT "healthcheck_skips_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthcheck_skips" ADD CONSTRAINT "healthcheck_skips_skipped_by_users_id_fk" FOREIGN KEY ("skipped_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_auto_revert" ADD CONSTRAINT "location_auto_revert_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_auto_revert" ADD CONSTRAINT "location_auto_revert_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_auto_revert" ADD CONSTRAINT "location_auto_revert_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_data_access" ADD CONSTRAINT "location_data_access_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_data_access" ADD CONSTRAINT "location_data_access_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_members" ADD CONSTRAINT "location_group_members_group_id_location_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."location_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_members" ADD CONSTRAINT "location_group_members_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_members" ADD CONSTRAINT "location_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_imports" ADD CONSTRAINT "location_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_imports" ADD CONSTRAINT "location_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_imports" ADD CONSTRAINT "location_imports_connection_id_google_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_imports" ADD CONSTRAINT "location_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pages" ADD CONSTRAINT "location_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pages" ADD CONSTRAINT "location_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pages" ADD CONSTRAINT "location_pages_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pages" ADD CONSTRAINT "location_pages_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_write_ops" ADD CONSTRAINT "location_write_ops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_write_ops" ADD CONSTRAINT "location_write_ops_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_write_ops" ADD CONSTRAINT "location_write_ops_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_connection_id_google_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_proposals" ADD CONSTRAINT "mcp_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_proposals" ADD CONSTRAINT "mcp_proposals_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_proposals" ADD CONSTRAINT "mcp_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_branding" ADD CONSTRAINT "org_branding_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_branding" ADD CONSTRAINT "org_branding_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_dataforseo_credentials" ADD CONSTRAINT "org_dataforseo_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_dataforseo_credentials" ADD CONSTRAINT "org_dataforseo_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_grid_settings" ADD CONSTRAINT "org_grid_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_grid_settings" ADD CONSTRAINT "org_grid_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_daily" ADD CONSTRAINT "performance_daily_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_daily" ADD CONSTRAINT "performance_daily_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_dfs_spend" ADD CONSTRAINT "platform_dfs_spend_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_templates" ADD CONSTRAINT "post_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_templates" ADD CONSTRAINT "post_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_templates" ADD CONSTRAINT "post_templates_image_id_post_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."post_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_templates" ADD CONSTRAINT "post_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_templates" ADD CONSTRAINT "post_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_applied_requested_by_users_id_fk" FOREIGN KEY ("applied_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_sets" ADD CONSTRAINT "profile_change_sets_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_targets" ADD CONSTRAINT "profile_change_targets_change_set_id_profile_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."profile_change_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_targets" ADD CONSTRAINT "profile_change_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_targets" ADD CONSTRAINT "profile_change_targets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_revert_change_set_id_profile_change_sets_id_fk" FOREIGN KEY ("revert_change_set_id") REFERENCES "public"."profile_change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_group_id_location_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."location_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_definition_id_report_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."report_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_share_links" ADD CONSTRAINT "report_share_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_share_links" ADD CONSTRAINT "report_share_links_report_run_id_report_runs_id_fk" FOREIGN KEY ("report_run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_share_links" ADD CONSTRAINT "report_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_auto_drafts" ADD CONSTRAINT "review_auto_drafts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_auto_drafts" ADD CONSTRAINT "review_auto_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_auto_drafts" ADD CONSTRAINT "review_auto_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_link_clicks" ADD CONSTRAINT "review_link_clicks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_link_clicks" ADD CONSTRAINT "review_link_clicks_link_id_review_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."review_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_publish_requested_by_users_id_fk" FOREIGN KEY ("publish_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_campaigns" ADD CONSTRAINT "review_request_campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_campaigns" ADD CONSTRAINT "review_request_campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_campaigns" ADD CONSTRAINT "review_request_campaigns_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_campaigns" ADD CONSTRAINT "review_request_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_optouts" ADD CONSTRAINT "review_request_optouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_optouts" ADD CONSTRAINT "review_request_optouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_recipients" ADD CONSTRAINT "review_request_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_recipients" ADD CONSTRAINT "review_request_recipients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_recipients" ADD CONSTRAINT "review_request_recipients_campaign_id_review_request_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."review_request_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_request_recipients" ADD CONSTRAINT "review_request_recipients_list_confirmed_by_users_id_fk" FOREIGN KEY ("list_confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_syncs" ADD CONSTRAINT "review_syncs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_syncs" ADD CONSTRAINT "review_syncs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_syncs" ADD CONSTRAINT "review_syncs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_topics" ADD CONSTRAINT "review_topics_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_topics" ADD CONSTRAINT "review_topics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_topics" ADD CONSTRAINT "review_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_topics" ADD CONSTRAINT "review_topics_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_keywords_monthly" ADD CONSTRAINT "search_keywords_monthly_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_keywords_monthly" ADD CONSTRAINT "search_keywords_monthly_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_cases" ADD CONSTRAINT "suspension_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_cases" ADD CONSTRAINT "suspension_cases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_cases" ADD CONSTRAINT "suspension_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_api_token_id_api_tokens_id_fk" FOREIGN KEY ("api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reply_settings" ADD CONSTRAINT "workspace_reply_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reply_settings" ADD CONSTRAINT "workspace_reply_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reply_settings" ADD CONSTRAINT "workspace_reply_settings_auto_approve_enabled_by_users_id_fk" FOREIGN KEY ("auto_approve_enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reply_settings" ADD CONSTRAINT "workspace_reply_settings_draft_on_arrival_by_users_id_fk" FOREIGN KEY ("draft_on_arrival_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reply_settings" ADD CONSTRAINT "workspace_reply_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_review_topic_settings" ADD CONSTRAINT "workspace_review_topic_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_review_topic_settings" ADD CONSTRAINT "workspace_review_topic_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_review_topic_settings" ADD CONSTRAINT "workspace_review_topic_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_workspace_idx" ON "ai_usage" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_visibility_results_run_idx" ON "ai_visibility_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_visibility_runs_location_idx" ON "ai_visibility_runs" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_visibility_runs_org_idx" ON "ai_visibility_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_visibility_settings_org_idx" ON "ai_visibility_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "citation_entries_location_site_unique" ON "citation_entries" USING btree ("location_id","site_key") WHERE "citation_entries"."site_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "citation_entries_location_idx" ON "citation_entries" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "competitor_profile_tasks_org_idx" ON "competitor_profile_tasks" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_profile_tasks_open_idx" ON "competitor_profile_tasks" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_profiles_key" ON "competitor_profiles" USING btree ("org_id","place_id","data_source","fetched_on");--> statement-breakpoint
CREATE INDEX "competitor_profiles_org_place_idx" ON "competitor_profiles" USING btree ("org_id","place_id");--> statement-breakpoint
CREATE INDEX "error_events_last_seen_idx" ON "error_events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "google_media_org_location_idx" ON "google_media" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE INDEX "google_notifications_org_id_received_at_idx" ON "google_notifications" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "google_posts_org_location_idx" ON "google_posts" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grid_competitor_snapshots_key" ON "grid_competitor_snapshots" USING btree ("config_id","keyword","place_id","snapshot_date","data_source");--> statement-breakpoint
CREATE INDEX "grid_competitor_snapshots_org_idx" ON "grid_competitor_snapshots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "grid_configs_org_idx" ON "grid_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "grid_runs_config_idx" ON "grid_runs" USING btree ("config_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "grid_tasks_task_ref_unique" ON "grid_tasks" USING btree ("task_ref");--> statement-breakpoint
CREATE INDEX "grid_tasks_run_idx" ON "grid_tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grid_tasks_status_submitted_idx" ON "grid_tasks" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "location_write_ops_org_location_idx" ON "location_write_ops" USING btree ("org_id","location_id","created_at");--> statement-breakpoint
CREATE INDEX "location_write_ops_batch_idx" ON "location_write_ops" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "location_write_ops_due_idx" ON "location_write_ops" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_google_location_id_active_unique" ON "locations" USING btree ("google_location_id") WHERE "locations"."status" = 'active' AND "locations"."google_location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_proposals_org_token_idx" ON "mcp_proposals" USING btree ("org_id","token_id","created_at");--> statement-breakpoint
CREATE INDEX "media_uploads_status_created_idx" ON "media_uploads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_org_id_read_at_idx" ON "notifications" USING btree ("user_id","org_id","read_at");--> statement-breakpoint
CREATE INDEX "performance_daily_org_idx" ON "performance_daily" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "platform_dfs_spend_created_idx" ON "platform_dfs_spend" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_edits_one_open_per_post_idx" ON "post_edits" USING btree ("post_id") WHERE "post_edits"."status" in ('pending_approval', 'applying');--> statement-breakpoint
CREATE INDEX "post_edits_org_workspace_status_idx" ON "post_edits" USING btree ("org_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "post_images_workspace_created_idx" ON "post_images" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "post_targets_org_location_idx" ON "post_targets" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE INDEX "posts_org_workspace_status_idx" ON "posts" USING btree ("org_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "posts_due_idx" ON "posts" USING btree ("scheduled_for") WHERE "posts"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "posts_summary_trgm_idx" ON "posts" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "profile_change_sets_org_workspace_status_idx" ON "profile_change_sets" USING btree ("org_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "profile_change_targets_org_location_idx" ON "profile_change_targets" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE INDEX "profile_changes_org_location_status_idx" ON "profile_changes" USING btree ("org_id","location_id","status");--> statement-breakpoint
CREATE INDEX "profile_snapshots_location_taken_idx" ON "profile_snapshots" USING btree ("location_id","taken_at");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_org_id_idx" ON "push_subscriptions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "report_definitions_org_idx" ON "report_definitions" USING btree ("org_id","workspace_id");--> statement-breakpoint
CREATE INDEX "report_runs_definition_idx" ON "report_runs" USING btree ("definition_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_runs_schedule_unique" ON "report_runs" USING btree ("definition_id","period_start","period_end") WHERE "report_runs"."trigger" = 'schedule';--> statement-breakpoint
CREATE UNIQUE INDEX "report_share_links_token_hash_unique" ON "report_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "review_assignments_org_assignee_idx" ON "review_assignments" USING btree ("org_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "review_notes_review_idx" ON "review_notes" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_replies_one_open_per_review" ON "review_replies" USING btree ("review_id") WHERE "review_replies"."status" in ('draft', 'pending_approval', 'approved', 'blocked', 'failed');--> statement-breakpoint
CREATE INDEX "review_replies_org_workspace_status_idx" ON "review_replies" USING btree ("org_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "review_request_campaigns_ws_idx" ON "review_request_campaigns" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "review_request_recipients_due_idx" ON "review_request_recipients" USING btree ("status","sent_at");--> statement-breakpoint
CREATE INDEX "review_topics_workspace_idx" ON "review_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "review_topics_location_idx" ON "review_topics" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "review_topics_topics_gin_idx" ON "review_topics" USING gin ("topics");--> statement-breakpoint
CREATE INDEX "reviews_org_workspace_location_idx" ON "reviews" USING btree ("org_id","workspace_id","location_id");--> statement-breakpoint
CREATE INDEX "reviews_location_unreplied_idx" ON "reviews" USING btree ("location_id",("reply_comment" is null));--> statement-breakpoint
CREATE INDEX "reviews_create_time_idx" ON "reviews" USING btree ("create_time");--> statement-breakpoint
CREATE INDEX "reviews_comment_trgm_idx" ON "reviews" USING gin ("comment" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reviews_reviewer_trgm_idx" ON "reviews" USING gin ("reviewer_display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_keywords_monthly_org_idx" ON "search_keywords_monthly" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stored_files_org_workspace_idx" ON "stored_files" USING btree ("org_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_dedupe_unique" ON "stored_files" USING btree ("org_id","kind",coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),"sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_logo_slot_unique" ON "stored_files" USING btree ("org_id",coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "stored_files"."kind" = 'logo';--> statement-breakpoint
CREATE INDEX "suspension_cases_org_location_idx" ON "suspension_cases" USING btree ("org_id","location_id","status");--> statement-breakpoint
CREATE INDEX "two_factors_secret_idx" ON "two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factors_user_id_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_unique" ON "webhook_deliveries" USING btree ("subscription_id","event_type","entity_id") WHERE "webhook_deliveries"."test" = false;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_created_idx" ON "webhook_deliveries" USING btree ("subscription_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_status_idx" ON "webhook_subscriptions" USING btree ("org_id","status");