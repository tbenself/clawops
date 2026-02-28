import { v } from "convex/values";
import { mutation, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { cardState, cardSpec } from "./schema";
import type { CardState } from "./schema";

// ── Helpers ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}

// Valid state transitions per §9.2
const VALID_TRANSITIONS: Record<CardState, CardState[]> = {
  READY: ["RUNNING"],
  RUNNING: ["DONE", "NEEDS_DECISION", "FAILED", "RETRY_SCHEDULED"],
  NEEDS_DECISION: ["RUNNING", "FAILED"],
  RETRY_SCHEDULED: ["READY"],
  DONE: [],
  FAILED: [],
};

// ── createCard ──────────────────────────────────────────────────

export const createCard = mutation({
  args: {
    tenantId: v.string(),
    projectId: v.string(),
    commandId: v.string(),
    correlationId: v.string(),
    title: v.string(),
    priority: v.number(),
    spec: cardSpec,
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cardId = generateId("card");

    const docId = await ctx.db.insert("cards", {
      cardId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      state: "READY",
      priority: args.priority,
      title: args.title,
      spec: args.spec,
      createdTs: now,
      updatedTs: now,
      attempt: 0,
      capabilities: args.capabilities,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: args.tenantId,
      projectId: args.projectId,
      type: "CardCreated",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      commandId: args.commandId,
      cardId,
      producer: { service: "clawops-cards", version: "0.1.0" },
      payload: {
        title: args.title,
        priority: args.priority,
        spec: args.spec,
      },
    });

    return { cardId, _id: docId };
  },
});

// ── transitionCard (internal, validates §9.2 state machine) ─────

export const transitionCard = internalMutation({
  args: {
    cardId: v.string(),
    to: cardState,
    reason: v.string(),
    correlationId: v.string(),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    decisionId: v.optional(v.string()),
    retryAtTs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const card = await ctx.db
      .query("cards")
      .withIndex("by_cardId", (q) => q.eq("cardId", args.cardId))
      .unique();

    if (!card) {
      throw new Error(`Card not found: ${args.cardId}`);
    }

    const from = card.state;
    const allowed = VALID_TRANSITIONS[from];

    if (!allowed.includes(args.to)) {
      throw new Error(`Invalid card transition: ${from} → ${args.to}`);
    }

    const now = Date.now();

    const patch: Record<string, unknown> = {
      state: args.to,
      updatedTs: now,
    };

    if (args.to === "RUNNING") {
      patch.attempt = card.attempt + 1;
    }

    if (args.to === "RETRY_SCHEDULED" && args.retryAtTs !== undefined) {
      patch.retryAtTs = args.retryAtTs;
    }

    if (from === "RETRY_SCHEDULED") {
      patch.retryAtTs = undefined;
    }

    await ctx.db.patch(card._id, patch);

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: card.tenantId,
      projectId: card.projectId,
      type: "CardTransitioned",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      commandId: args.commandId,
      runId: args.runId,
      cardId: card.cardId,
      decisionId: args.decisionId,
      producer: { service: "clawops-cards", version: "0.1.0" },
      payload: {
        from,
        to: args.to,
        reason: args.reason,
      },
    });

    return { from, to: args.to };
  },
});

// ── cardsByState query ──────────────────────────────────────────

export const cardsByState = query({
  args: {
    projectId: v.string(),
    state: cardState,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cards")
      .withIndex("by_projectId_state_priority", (q) =>
        q.eq("projectId", args.projectId).eq("state", args.state),
      )
      .collect();
  },
});

// ── eventChain query ────────────────────────────────────────────

export const eventChain = query({
  args: {
    projectId: v.string(),
    correlationId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("events")
      .withIndex("by_projectId_correlationId_ts", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("correlationId", args.correlationId),
      )
      .collect();
  },
});
