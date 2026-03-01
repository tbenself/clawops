import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  decisionOption,
  sourceThread,
  urgencyLevel,
} from "./schema";
import { withAuth, withAuthQ, ALL_ROLES } from "./auth";

// Default claim duration: 5 minutes (§6.6)
const DECISION_CLAIM_MS = 5 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}

// ── requestDecision (bot/owner) ─────────────────────────────────

export const requestDecision = mutation({
  args: {
    projectId: v.string(),
    cardId: v.string(),
    commandId: v.string(),
    runId: v.string(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    urgency: urgencyLevel,
    title: v.string(),
    contextSummary: v.optional(v.string()),
    options: v.array(decisionOption),
    artifactRefs: v.optional(v.array(v.string())),
    sourceThread: v.optional(sourceThread),
    expiresAt: v.optional(v.number()),
    fallbackOption: v.optional(v.string()),
  },
  handler: withAuth({ roles: ["bot", "owner"] }, async (ctx, args, auth) => {
    if (args.options.length === 0) {
      throw new Error("Decision must have at least one option");
    }

    if (
      args.fallbackOption !== undefined &&
      !args.options.some((o) => o.key === args.fallbackOption)
    ) {
      throw new Error(
        `fallbackOption "${args.fallbackOption}" must match an option key`,
      );
    }

    const now = Date.now();
    const decisionId = generateId("dec");

    const docId = await ctx.db.insert("decisions", {
      decisionId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      cardId: args.cardId,
      commandId: args.commandId,
      runId: args.runId,
      state: "PENDING",
      urgency: args.urgency,
      title: args.title,
      contextSummary: args.contextSummary,
      options: args.options,
      artifactRefs: args.artifactRefs,
      sourceThread: args.sourceThread,
      requestedAt: now,
      expiresAt: args.expiresAt,
      fallbackOption: args.fallbackOption,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      type: "DecisionRequested",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      causationId: args.causationId,
      commandId: args.commandId,
      runId: args.runId,
      cardId: args.cardId,
      decisionId,
      producer: { service: "clawops-decisions", version: "0.1.0" },
      payload: {
        title: args.title,
        urgency: args.urgency,
        optionKeys: args.options.map((o) => o.key),
        expiresAt: args.expiresAt,
        fallbackOption: args.fallbackOption,
      },
    });

    return { decisionId, _id: docId };
  }),
});

// ── _httpRequestDecision (HTTP adapter, no RBAC) ────────────────

export const _httpRequestDecision = internalMutation({
  args: {
    tenantId: v.string(),
    projectId: v.string(),
    cardId: v.string(),
    commandId: v.string(),
    runId: v.string(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    urgency: urgencyLevel,
    title: v.string(),
    contextSummary: v.optional(v.string()),
    options: v.array(decisionOption),
    artifactRefs: v.optional(v.array(v.string())),
    sourceThread: v.optional(sourceThread),
    expiresAt: v.optional(v.number()),
    fallbackOption: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.options.length === 0) {
      throw new Error("Decision must have at least one option");
    }

    if (
      args.fallbackOption !== undefined &&
      !args.options.some((o) => o.key === args.fallbackOption)
    ) {
      throw new Error(
        `fallbackOption "${args.fallbackOption}" must match an option key`,
      );
    }

    const now = Date.now();
    const decisionId = generateId("dec");

    await ctx.db.insert("decisions", {
      decisionId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      cardId: args.cardId,
      commandId: args.commandId,
      runId: args.runId,
      state: "PENDING",
      urgency: args.urgency,
      title: args.title,
      contextSummary: args.contextSummary,
      options: args.options,
      artifactRefs: args.artifactRefs,
      sourceThread: args.sourceThread,
      requestedAt: now,
      expiresAt: args.expiresAt,
      fallbackOption: args.fallbackOption,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: args.tenantId,
      projectId: args.projectId,
      type: "DecisionRequested",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      causationId: args.causationId,
      commandId: args.commandId,
      runId: args.runId,
      cardId: args.cardId,
      decisionId,
      producer: { service: "clawops-decisions", version: "0.1.0" },
      payload: {
        title: args.title,
        urgency: args.urgency,
        optionKeys: args.options.map((o) => o.key),
        expiresAt: args.expiresAt,
        fallbackOption: args.fallbackOption,
      },
    });

    return { decisionId };
  },
});

// ── claimDecision (§6.6, operator/owner) ────────────────────────

export const claimDecision = mutation({
  args: {
    projectId: v.string(),
    decisionId: v.string(),
  },
  handler: withAuth({ roles: ["operator", "owner"] }, async (ctx, args, auth) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("by_decisionId", (q) => q.eq("decisionId", args.decisionId))
      .unique();

    if (!decision) {
      throw new Error("Decision not found");
    }

    // Cross-project check
    if (decision.projectId !== auth.projectId) {
      throw new Error("Decision not found");
    }

    if (decision.state !== "PENDING" && decision.state !== "CLAIMED") {
      throw new Error(`Cannot claim decision in state ${decision.state}`);
    }

    const now = Date.now();

    // If claimed by someone else and claim hasn't expired
    if (
      decision.claimedBy !== undefined &&
      decision.claimedBy !== auth.userId &&
      decision.claimedUntil !== undefined &&
      decision.claimedUntil > now
    ) {
      return {
        status: "already_claimed" as const,
        claimedBy: decision.claimedBy,
        claimedUntil: decision.claimedUntil,
      };
    }

    const claimedUntil = now + DECISION_CLAIM_MS;

    await ctx.db.patch(decision._id, {
      state: "CLAIMED",
      claimedBy: auth.userId,
      claimedUntil,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      type: "DecisionClaimed",
      version: 1,
      ts: now,
      correlationId: decision.commandId,
      commandId: decision.commandId,
      runId: decision.runId,
      cardId: decision.cardId,
      decisionId: decision.decisionId,
      producer: { service: "clawops-decisions", version: "0.1.0" },
      payload: {
        claimedBy: auth.userId,
        claimedUntil,
      },
    });

    return { status: "claimed" as const, claimedUntil };
  }),
});

// ── renewDecisionClaim (§6.6, operator/owner) ───────────────────

export const renewDecisionClaim = mutation({
  args: {
    projectId: v.string(),
    decisionId: v.string(),
  },
  handler: withAuth({ roles: ["operator", "owner"] }, async (ctx, args, auth) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("by_decisionId", (q) => q.eq("decisionId", args.decisionId))
      .unique();

    if (!decision) {
      throw new Error("Decision not found");
    }

    if (decision.projectId !== auth.projectId) {
      throw new Error("Decision not found");
    }

    if (decision.state !== "CLAIMED" || decision.claimedBy !== auth.userId) {
      throw new Error("Cannot renew: decision is not claimed by you");
    }

    const claimedUntil = Date.now() + DECISION_CLAIM_MS;

    await ctx.db.patch(decision._id, { claimedUntil });

    // No event emitted — renewals are high-frequency and low-signal (§6.6)
    return { claimedUntil };
  }),
});

// ── renderDecision (§6.5 — compare-and-set, operator/owner) ────

export const renderDecision = mutation({
  args: {
    projectId: v.string(),
    decisionId: v.string(),
    optionKey: v.string(),
    note: v.optional(v.string()),
  },
  handler: withAuth({ roles: ["operator", "owner"] }, async (ctx, args, auth) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("by_decisionId", (q) => q.eq("decisionId", args.decisionId))
      .unique();

    if (!decision) {
      throw new Error("Decision not found");
    }

    if (decision.projectId !== auth.projectId) {
      throw new Error("Decision not found");
    }

    const now = Date.now();

    // CAS check: only PENDING or CLAIMED are renderable.
    // Return rejection status (don't throw) so the rejection event commits.
    if (decision.state !== "PENDING" && decision.state !== "CLAIMED") {
      await ctx.runMutation(internal.events.appendEvent, {
        eventId: generateId("evt"),
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        type: "DecisionRenderRejected",
        version: 1,
        ts: now,
        correlationId: decision.commandId,
        commandId: decision.commandId,
        runId: decision.runId,
        cardId: decision.cardId,
        decisionId: decision.decisionId,
        producer: { service: "clawops-decisions", version: "0.1.0" },
        payload: {
          attemptedOption: args.optionKey,
          attemptedBy: auth.userId,
          currentState: decision.state,
        },
      });

      return {
        status: "rejected" as const,
        reason: `Decision already resolved (state: ${decision.state})`,
      };
    }

    // If CLAIMED, verify the caller owns the claim
    if (
      decision.state === "CLAIMED" &&
      decision.claimedBy !== undefined &&
      decision.claimedBy !== auth.userId
    ) {
      await ctx.runMutation(internal.events.appendEvent, {
        eventId: generateId("evt"),
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        type: "DecisionRenderRejected",
        version: 1,
        ts: now,
        correlationId: decision.commandId,
        commandId: decision.commandId,
        runId: decision.runId,
        cardId: decision.cardId,
        decisionId: decision.decisionId,
        producer: { service: "clawops-decisions", version: "0.1.0" },
        payload: {
          attemptedOption: args.optionKey,
          attemptedBy: auth.userId,
          currentState: decision.state,
          reason: "claimed_by_another",
        },
      });

      return {
        status: "rejected" as const,
        reason: "Decision is claimed by another operator",
      };
    }

    // Validate option key exists
    if (!decision.options.some((o) => o.key === args.optionKey)) {
      throw new Error(`Invalid option key "${args.optionKey}"`);
    }

    // Render
    await ctx.db.patch(decision._id, {
      state: "RENDERED",
      renderedOption: args.optionKey,
      renderedBy: auth.userId,
      renderedAt: now,
      // Clear claim fields
      claimedBy: undefined,
      claimedUntil: undefined,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      type: "DecisionRendered",
      version: 1,
      ts: now,
      correlationId: decision.commandId,
      commandId: decision.commandId,
      runId: decision.runId,
      cardId: decision.cardId,
      decisionId: decision.decisionId,
      producer: { service: "clawops-decisions", version: "0.1.0" },
      payload: {
        selectedOption: args.optionKey,
        renderedBy: auth.userId,
        note: args.note,
      },
    });

    return { status: "rendered" as const, optionKey: args.optionKey };
  }),
});

// ── pendingDecisions query (any role) ───────────────────────────

export const pendingDecisions = query({
  args: {
    projectId: v.string(),
    urgency: v.optional(urgencyLevel),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, _auth) => {
    // Fetch PENDING decisions
    const pending = await ctx.db
      .query("decisions")
      .withIndex("by_projectId_state_urgency", (q) => {
        const base = q.eq("projectId", args.projectId).eq("state", "PENDING");
        if (args.urgency !== undefined) return base.eq("urgency", args.urgency);
        return base;
      })
      .collect();

    // Fetch CLAIMED decisions
    const claimed = await ctx.db
      .query("decisions")
      .withIndex("by_projectId_state_urgency", (q) => {
        const base = q.eq("projectId", args.projectId).eq("state", "CLAIMED");
        if (args.urgency !== undefined) return base.eq("urgency", args.urgency);
        return base;
      })
      .collect();

    const all = [...pending, ...claimed];

    // Sort by urgency priority (now > today > whenever), then requestedAt ascending
    const urgencyOrder = { now: 0, today: 1, whenever: 2 };
    all.sort((a, b) => {
      const ua = urgencyOrder[a.urgency];
      const ub = urgencyOrder[b.urgency];
      if (ua !== ub) return ua - ub;
      return a.requestedAt - b.requestedAt;
    });

    return all;
  }),
});

// ── decisionDetail query (any role) ─────────────────────────────

export const decisionDetail = query({
  args: {
    projectId: v.string(),
    decisionId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, auth) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("by_decisionId", (q) => q.eq("decisionId", args.decisionId))
      .unique();

    if (!decision) return null;

    // Cross-project check
    if (decision.projectId !== auth.projectId) return null;

    // Assemble context bundle (§6.2) at read time
    // Fetch the originating command
    const command = await ctx.db
      .query("commands")
      .withIndex("by_commandId", (q) => q.eq("commandId", decision.commandId))
      .unique();

    // Fetch artifacts referenced by this decision
    const artifacts = decision.artifactRefs
      ? await Promise.all(
          decision.artifactRefs.map((ref) =>
            ctx.db
              .query("artifacts")
              .withIndex("by_artifactId", (q) => q.eq("artifactId", ref))
              .unique(),
          ),
        )
      : [];

    // Fetch event chain for correlation context
    const events = await ctx.db
      .query("events")
      .withIndex("by_projectId_correlationId_ts", (q) =>
        q
          .eq("projectId", decision.projectId)
          .eq("correlationId", decision.commandId),
      )
      .collect();

    return {
      ...decision,
      context: {
        command: command?.commandSpec ?? null,
        artifacts: artifacts.filter(Boolean),
        eventChain: events.map((e) => ({
          eventId: e.eventId,
          type: e.type,
          ts: e.ts,
        })),
      },
    };
  }),
});
