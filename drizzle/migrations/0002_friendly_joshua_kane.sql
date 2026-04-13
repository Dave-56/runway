CREATE TYPE "public"."memory_source" AS ENUM('user_stated', 'agent_inferred');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('financial', 'behavioral', 'life_event', 'goal');--> statement-breakpoint
ALTER TABLE "conversation_memory" ADD COLUMN "type" "memory_type" DEFAULT 'behavioral' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_memory" ADD COLUMN "source" "memory_source" DEFAULT 'agent_inferred' NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_memory_user_type_idx" ON "conversation_memory" USING btree ("user_id","type");