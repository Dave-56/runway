import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  date,
  index,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────

export const phaseEnum = pgEnum("phase", [
  "know_number",
  "allocate",
  "stay_honest",
]);

export const frequencyEnum = pgEnum("frequency", [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annually",
]);

export const obligationCategoryEnum = pgEnum("obligation_category", [
  "housing",
  "transport",
  "insurance",
  "loan",
  "subscription",
  "utility",
  "other",
]);

export const obligationStatusEnum = pgEnum("obligation_status", [
  "active",
  "dead",
  "confirmed",
]);

export const strategyEnum = pgEnum("strategy", [
  "avalanche",
  "snowball",
  "hybrid",
  "none",
]);

export const checkinTypeEnum = pgEnum("checkin_type", [
  "weekly_checkin",
  "alert",
  "milestone",
]);

// ── Tables ─────────────────────────────────────────────────────────────

export const user = pgTable(
  "user",
  {
    id: serial("id").primaryKey(),
    telegramChatId: text("telegram_chat_id").notNull().unique(),
    timezone: text("timezone").default("America/New_York"),
    checkinDay: integer("checkin_day").notNull().default(0),
    checkinHour: integer("checkin_hour").notNull().default(10),
    phase: phaseEnum("phase").notNull().default("know_number"),
    ignoredCheckins: integer("ignored_checkins").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("user_telegram_chat_id_idx").on(t.telegramChatId)],
);

export const plaidConnection = pgTable("plaid_connection", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.id),
  accessToken: text("access_token").notNull(),
  itemId: text("item_id").notNull(),
  institutionName: text("institution_name"),
  cursor: text("cursor"),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const obligation = pgTable(
  "obligation",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => user.id),
    plaidStreamId: text("plaid_stream_id"),
    merchantName: text("merchant_name").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
    frequency: frequencyEnum("frequency").notNull(),
    nextExpectedDate: date("next_expected_date"),
    category: obligationCategoryEnum("category").notNull().default("other"),
    isSubscription: boolean("is_subscription").notNull().default(false),
    status: obligationStatusEnum("status").notNull().default("active"),
    cancelUrl: text("cancel_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("obligation_user_id_idx").on(t.userId),
    index("obligation_status_idx").on(t.status),
  ],
);

export const allocation = pgTable("allocation", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.id),
  monthlyIncome: numeric("monthly_income", { precision: 12, scale: 2, mode: "number" }),
  obligationsTotal: numeric("obligations_total", { precision: 12, scale: 2, mode: "number" }),
  gap: numeric("gap", { precision: 12, scale: 2, mode: "number" }),
  debtAmount: numeric("debt_amount", { precision: 12, scale: 2, mode: "number" }),
  cushionAmount: numeric("cushion_amount", { precision: 12, scale: 2, mode: "number" }),
  livingAmount: numeric("living_amount", { precision: 12, scale: 2, mode: "number" }),
  strategy: strategyEnum("strategy").notNull().default("none"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const debt = pgTable("debt", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.id),
  accountName: text("account_name").notNull(),
  plaidAccountId: text("plaid_account_id"),
  currentBalance: numeric("current_balance", { precision: 12, scale: 2, mode: "number" }),
  interestRate: numeric("interest_rate", { precision: 5, scale: 2, mode: "number" }),
  minimumPayment: numeric("minimum_payment", { precision: 12, scale: 2, mode: "number" }),
  priorityOrder: integer("priority_order"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const debtSnapshot = pgTable("debt_snapshot", {
  id: serial("id").primaryKey(),
  debtId: integer("debt_id")
    .notNull()
    .references(() => debt.id),
  balance: numeric("balance", { precision: 12, scale: 2, mode: "number" }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const checkinLog = pgTable(
  "checkin_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => user.id),
    type: checkinTypeEnum("type").notNull(),
    messageText: text("message_text"),
    telegramMessageId: integer("telegram_message_id"),
    userReplied: boolean("user_replied").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("checkin_log_user_id_idx").on(t.userId),
    index("checkin_log_sent_at_idx").on(t.sentAt),
  ],
);

export const conversationMemory = pgTable("conversation_memory", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.id),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
