import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// ── Command Projector ───────────────────────────────────────────
// Handles: CommandRequested, CommandStarted, CommandSucceeded,
//          CommandFailed, CommandCanceled

export const projectCommandEvent = internalMutation({
  args: {
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    type: v.string(),
    ts: v.number(),
    commandId: v.string(),
    runId: v.optional(v.string()),
    payload: v.any(),
    replay: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("commands")
      .withIndex("by_commandId", (q) => q.eq("commandId", args.commandId))
      .unique();

    // Idempotency: skip if we've already processed this or a later event
    if (existing?.lastEventId !== undefined && existing.lastEventId >= args.eventId) {
      return { skipped: true };
    }

    if (args.type === "CommandRequested" && !existing) {
      await ctx.db.insert("commands", {
        commandId: args.commandId,
        tenantId: args.tenantId,
        projectId: args.projectId,
        status: "PENDING",
        lastEventId: args.eventId,
        updatedTs: args.ts,
        priority: args.payload.commandSpec?.constraints?.priority ?? 50,
        commandSpec: args.payload.commandSpec,
      });
      return { created: true };
    }

    if (!existing) return { skipped: true };

    const patch: Record<string, unknown> = {
      lastEventId: args.eventId,
      updatedTs: args.ts,
    };

    switch (args.type) {
      case "CommandStarted":
        patch.status = "RUNNING";
        patch.latestRunId = args.runId;
        break;
      case "CommandSucceeded":
        patch.status = "SUCCEEDED";
        break;
      case "CommandFailed":
        patch.status = "FAILED";
        break;
      case "CommandCanceled":
        patch.status = "CANCELED";
        break;
    }

    await ctx.db.patch(existing._id, patch);
    return { updated: true };
  },
});

// ── Run Projector ───────────────────────────────────────────────
// Handles: CommandStarted (creates run), CommandSucceeded/Failed (ends run)

export const projectRunEvent = internalMutation({
  args: {
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    type: v.string(),
    ts: v.number(),
    commandId: v.string(),
    runId: v.string(),
    payload: v.any(),
    replay: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();

    switch (args.type) {
      case "CommandStarted":
        if (!existing) {
          await ctx.db.insert("runs", {
            runId: args.runId,
            tenantId: args.tenantId,
            projectId: args.projectId,
            commandId: args.commandId,
            status: "RUNNING",
            startedTs: args.ts,
            attempt: args.payload.attempt ?? 1,
          });
          return { created: true };
        }
        return { skipped: true };

      case "CommandSucceeded":
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: "SUCCEEDED",
            endedTs: args.ts,
          });
          return { updated: true };
        }
        break;

      case "CommandFailed":
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: "FAILED",
            endedTs: args.ts,
            error: args.payload.error,
          });
          return { updated: true };
        }
        break;
    }

    return { skipped: true };
  },
});

// ── Card Projector ──────────────────────────────────────────────
// Handles: CardCreated, CardTransitioned
// Replay-safe: uses upsert semantics

export const projectCardEvent = internalMutation({
  args: {
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    type: v.string(),
    ts: v.number(),
    cardId: v.string(),
    payload: v.any(),
    replay: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cards")
      .withIndex("by_cardId", (q) => q.eq("cardId", args.cardId))
      .unique();

    switch (args.type) {
      case "CardCreated":
        if (!existing) {
          await ctx.db.insert("cards", {
            cardId: args.cardId,
            tenantId: args.tenantId,
            projectId: args.projectId,
            state: "READY",
            priority: args.payload.priority ?? 50,
            title: args.payload.title,
            spec: args.payload.spec ?? { commandType: "unknown" },
            createdTs: args.ts,
            updatedTs: args.ts,
            attempt: 0,
          });
          return { created: true };
        }
        return { skipped: true };

      case "CardTransitioned":
        if (existing) {
          const patch: Record<string, unknown> = {
            state: args.payload.to,
            updatedTs: args.ts,
          };

          if (args.payload.to === "RUNNING") {
            patch.attempt = existing.attempt + 1;
          }

          if (args.payload.to === "RETRY_SCHEDULED" && args.payload.retryAtTs !== undefined) {
            patch.retryAtTs = args.payload.retryAtTs;
          }

          if (args.payload.from === "RETRY_SCHEDULED") {
            patch.retryAtTs = undefined;
          }

          await ctx.db.patch(existing._id, patch);
          return { updated: true };
        }
        break;
    }

    return { skipped: true };
  },
});
