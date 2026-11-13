ALTER TABLE "error_events" ADD COLUMN IF NOT EXISTS "last_context" text;--> statement-breakpoint
ALTER TABLE "google_connections" ADD COLUMN IF NOT EXISTS "access_lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "first_draft_review_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_first_draft_review_id_reviews_id_fk" FOREIGN KEY ("first_draft_review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_syncs_location_finished_idx" ON "review_syncs" USING btree ("location_id","finished_at" DESC NULLS LAST);