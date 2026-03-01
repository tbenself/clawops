import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { commandSpec } from "./schema";
import { withAuth } from "./auth";

// ── Helpers ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}

// ── requestCommand (operator/bot/owner) ─────────────────────────
// Emits CommandRequested, creates card in READY state, inserts
// commands read model — all in one transaction.

export const requestCommand = mutation({
  args: {
    projectId: v.string(),
    correlationId: v.string(),
    title: v.string(),
    commandSpec: commandSpec,
    capabilities: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
  },
  handler: withAuth({ roles: ["operator", "bot", "owner"] }, async (ctx, args, auth) => {
    const now = Date.now();
    const commandId = generateId("cmd");
    const cardId = generateId("card");
    const priority = args.commandSpec.constraints?.priority ?? 50;

    // 1. Emit CommandRequested event
    const eventId = generateId("evt");
    await ctx.runMutation(internal.events.appendEvent, {
      eventId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      type: "CommandRequested",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      commandId,
      cardId,
      idempotencyKey: args.idempotencyKey,
      producer: { service: "clawops-commands", version: "0.1.0" },
      payload: {
        commandSpec: args.commandSpec,
        title: args.title,
      },
    });

    // 2. Insert command read model
    await ctx.db.insert("commands", {
      commandId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      status: "PENDING",
      lastEventId: eventId,
      updatedTs: now,
      priority,
      commandSpec: args.commandSpec,
    });

    // 3. Create card in READY state
    await ctx.db.insert("cards", {
      cardId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      state: "READY",
      priority,
      title: args.title,
      spec: {
        commandType: args.commandSpec.commandType,
        args: args.commandSpec.args,
        constraints: args.commandSpec.constraints
          ? {
              concurrencyKey: args.commandSpec.constraints.concurrencyKey,
              maxRetries: args.commandSpec.constraints.maxRetries,
            }
          : undefined,
      },
      createdTs: now,
      updatedTs: now,
      attempt: 0,
      capabilities: args.capabilities,
    });

    // 4. Emit CardCreated event
    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      type: "CardCreated",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      commandId,
      cardId,
      producer: { service: "clawops-commands", version: "0.1.0" },
      payload: {
        title: args.title,
        priority,
      },
    });

    return { commandId, cardId };
  }),
});

// ── _httpRequestCommand (HTTP adapter, no RBAC) ─────────────

export const _httpRequestCommand = internalMutation({
  args: {
    tenantId: v.string(),
    projectId: v.string(),
    correlationId: v.string(),
    title: v.string(),
    commandSpec: commandSpec,
    capabilities: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const commandId = generateId("cmd");
    const cardId = generateId("card");
    const priority = args.commandSpec.constraints?.priority ?? 50;

    const eventId = generateId("evt");
    await ctx.runMutation(internal.events.appendEvent, {
      eventId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      type: "CommandRequested",
      version: 1,
      ts: now,
      correlationId: args.correlationId,
      commandId,
      cardId,
      idempotencyKey: args.idempotencyKey,
      producer: { service: "clawops-commands", version: "0.1.0" },
      payload: {
        commandSpec: args.commandSpec,
        title: args.title,
      },
    });

    await ctx.db.insert("commands", {
      commandId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      status: "PENDING",
      lastEventId: eventId,
      updatedTs: now,
      priority,
      commandSpec: args.commandSpec,
    });

    await ctx.db.insert("cards", {
      cardId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      state: "READY",
      priority,
      title: args.title,
      spec: {
        commandType: args.commandSpec.commandType,
        args: args.commandSpec.args,
        constraints: args.commandSpec.constraints
          ? {
              concurrencyKey: args.commandSpec.constraints.concurrencyKey,
              maxRetries: args.commandSpec.constraints.maxRetries,
            }
          : undefined,
      },
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
      commandId,
      cardId,
      producer: { service: "clawops-commands", version: "0.1.0" },
      payload: {
        title: args.title,
        priority,
      },
    });

    return { commandId, cardId };
  },
});
