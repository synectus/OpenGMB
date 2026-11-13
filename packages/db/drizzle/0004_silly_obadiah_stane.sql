CREATE TABLE "dfs_geo_locations" (
	"country_iso" text NOT NULL,
	"location_code" integer NOT NULL,
	"location_name" text NOT NULL,
	"location_type" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dfs_geo_locations_country_iso_location_code_pk" PRIMARY KEY("country_iso","location_code")
);
--> statement-breakpoint
CREATE TABLE "seo_keyword_research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"location_id" uuid,
	"seed" text NOT NULL,
	"country_iso" text NOT NULL,
	"language_code" text NOT NULL,
	"city_location_name" text,
	"row_limit" integer NOT NULL,
	"cache_key" text NOT NULL,
	"data_source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"estimate_charge_usd" numeric(12, 4) NOT NULL,
	"provider_cost_usd" numeric(12, 6),
	"charged_usd" numeric(12, 4),
	"spend_id" uuid,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"local_volume_note" text,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "seo_keyword_research_runs" ADD CONSTRAINT "seo_keyword_research_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keyword_research_runs" ADD CONSTRAINT "seo_keyword_research_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keyword_research_runs" ADD CONSTRAINT "seo_keyword_research_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dfs_geo_locations_name_idx" ON "dfs_geo_locations" USING btree ("country_iso","location_name");--> statement-breakpoint
CREATE INDEX "seo_kr_runs_ws_idx" ON "seo_keyword_research_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "seo_kr_runs_cache_idx" ON "seo_keyword_research_runs" USING btree ("cache_key","created_at");--> statement-breakpoint
CREATE INDEX "seo_kr_runs_org_idx" ON "seo_keyword_research_runs" USING btree ("org_id","created_at");