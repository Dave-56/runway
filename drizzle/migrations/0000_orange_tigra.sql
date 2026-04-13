CREATE TYPE "public"."checkin_type" AS ENUM('weekly_checkin', 'alert', 'milestone');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('weekly', 'biweekly', 'monthly', 'quarterly', 'annually');--> statement-breakpoint
CREATE TYPE "public"."obligation_category" AS ENUM('housing', 'transport', 'insurance', 'loan', 'subscription', 'utility', 'other');--> statement-breakpoint
CREATE TYPE "public"."obligation_status" AS ENUM('active', 'dead', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('know_number', 'allocate', 'stay_honest');--> statement-breakpoint
CREATE TYPE "public"."strategy" AS ENUM('avalanche', 'snowball', 'hybrid', 'none');--> statement-breakpoint
CREATE TABLE "allocation" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"monthly_income" numeric(12, 2),
	"obligations_total" numeric(12, 2),
	"gap" numeric(12, 2),
	"debt_amount" numeric(12, 2),
	"cushion_amount" numeric(12, 2),
	"living_amount" numeric(12, 2),
	"strategy" "strategy" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkin_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "checkin_type" NOT NULL,
	"message_text" text,
	"telegram_message_id" integer,
	"user_replied" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_name" text NOT NULL,
	"plaid_account_id" text,
	"current_balance" numeric(12, 2),
	"interest_rate" numeric(5, 2),
	"minimum_payment" numeric(12, 2),
	"priority_order" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"debt_id" integer NOT NULL,
	"balance" numeric(12, 2) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligation" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"plaid_stream_id" text,
	"merchant_name" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"frequency" "frequency" NOT NULL,
	"next_expected_date" date,
	"category" "obligation_category" DEFAULT 'other' NOT NULL,
	"is_subscription" boolean DEFAULT false NOT NULL,
	"status" "obligation_status" DEFAULT 'active' NOT NULL,
	"cancel_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_connection" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"access_token" text NOT NULL,
	"item_id" text NOT NULL,
	"institution_name" text,
	"cursor" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York',
	"checkin_day" integer DEFAULT 0 NOT NULL,
	"checkin_hour" integer DEFAULT 10 NOT NULL,
	"phase" "phase" DEFAULT 'know_number' NOT NULL,
	"ignored_checkins" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_log" ADD CONSTRAINT "checkin_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_memory" ADD CONSTRAINT "conversation_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt" ADD CONSTRAINT "debt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_snapshot" ADD CONSTRAINT "debt_snapshot_debt_id_debt_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_connection" ADD CONSTRAINT "plaid_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkin_log_user_id_idx" ON "checkin_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "checkin_log_sent_at_idx" ON "checkin_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "obligation_user_id_idx" ON "obligation" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "obligation_status_idx" ON "obligation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_telegram_chat_id_idx" ON "user" USING btree ("telegram_chat_id");