import { v } from "convex/values";
import { mutation, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { eventType, producer } from "./schema";
import { withAuth } from "./auth";

// ── Secret Denylist (§14.2) ─────────────────────────────────────

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36,}/,
  /gho_[A-Za-z0-9_]{36,}/,
  /ghu_[A-Za-z0-9_]{36,}/,
  /ghs_[A-Za-z0-9_]{36,}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /sk_live_[A-Za-z0-9]{20,}/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /-----BEGIN\s+CERTIFICATE-----/,
  /xoxb-[A-Za-z0-9._-]{6,}/,
  /xoxp-[A-Za-z0-9._-]{6,}/,
  /AKIA[0-9A-Z]{16}/,
];

export function containsSecret(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return SECRET_PATTERNS.some((p) => p.test(value));
  }
  if (Array.isArray(value)) {
    return value.some(containsSecret);
  }
  if (typeof value === "object") {
    return Object.values(value).some(containsSecret);
  }
  return false;
}

// ── appendEvent (internal mutation — sole write path) ───────────

export const appendEvent = internalMutation({
  args: {
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    type: eventType,
    version: v.number(),
    ts: v.number(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    cardId: v.optional(v.string()),
    decisionId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    producer: producer,
    tags: v.optional(v.any()),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    // Secret denylist check on payload and tags
    if (containsSecret(args.payload)) {
      throw new Error(
        "Payload appears to contain a raw secret. Use a credential reference instead.",
      );
    }
    if (args.tags !== undefined && containsSecret(args.tags)) {
      throw new Error(
        "Tags appear to contain a raw secret. Use a credential reference instead.",
      );
    }

    // Idempotency check
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query("events")
        .withIndex("by_idempotencyKey", (q) =>
          q.eq("idempotencyKey", args.idempotencyKey),
        )
        .first();
      if (existing !== null) {
        return existing._id;
      }
    }

    return await ctx.db.insert("events", args);
  },
});

// ── Queries ─────────────────────────────────────────────────────

export const listByCorrelationId = internalQuery({
  args: {
    projectId: v.string(),
    correlationId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("events")
      .withIndex("by_projectId_correlationId_ts", (q) =>
        q.eq("projectId", args.projectId).eq("correlationId", args.correlationId),
      )
      .collect();
  },
});

export const listByType = internalQuery({
  args: {
    type: eventType,
    sinceTs: v.optional(v.number()),
    untilTs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db
      .query("events")
      .withIndex("by_type_ts", (q) => {
        const base = q.eq("type", args.type);
        if (args.sinceTs !== undefined && args.untilTs !== undefined) {
          return base.gte("ts", args.sinceTs).lte("ts", args.untilTs);
        }
        if (args.sinceTs !== undefined) {
          return base.gte("ts", args.sinceTs);
        }
        if (args.untilTs !== undefined) {
          return base.lte("ts", args.untilTs);
        }
        return base;
      });

    if (args.limit !== undefined) {
      return await q.take(args.limit);
    }
    return await q.collect();
  },
});

export const listByTsRange = internalQuery({
  args: {
    projectId: v.string(),
    sinceTs: v.number(),
    untilTs: v.optional(v.number()),
    afterEventId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const rows = await ctx.db
      .query("events")
      .withIndex("by_projectId_ts", (q) => {
        const base = q.eq("projectId", args.projectId).gte("ts", args.sinceTs);
        if (args.untilTs !== undefined) {
          return base.lte("ts", args.untilTs);
        }
        return base;
      })
      .take(args.afterEventId !== undefined ? limit + 1000 : limit);

    // Composite cursor: skip events at the boundary timestamp that we've already seen.
    // afterEventId is a ULID, so lexicographic comparison gives us the right cutoff.
    let filtered = rows;
    if (args.afterEventId !== undefined) {
      filtered = rows.filter((e) => {
        if (e.ts > args.sinceTs) return true;
        // At the boundary timestamp, only include events with eventId > afterEventId
        return e.eventId > args.afterEventId!;
      });
    }

    return filtered.slice(0, limit);
  },
});

// ── emitEvent (public, auth-gated — bot/owner only) ─────────────

export const emitEvent = mutation({
  args: {
    projectId: v.string(),
    eventId: v.string(),
    type: eventType,
    version: v.number(),
    ts: v.number(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    cardId: v.optional(v.string()),
    decisionId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    producer: producer,
    tags: v.optional(v.any()),
    payload: v.any(),
  },
  handler: withAuth({ roles: ["bot", "owner"] }, async (ctx, args, auth) => {
    return await ctx.runMutation(internal.events.appendEvent, {
      ...args,
      tenantId: auth.tenantId,
    });
  }),
});
