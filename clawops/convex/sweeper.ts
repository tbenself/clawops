import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Constants ───────────────────────────────────────────────────

const DEFER_EXTENSION_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOW_BACKLOG_DEFER_THRESHOLD = 2;
const NOW_BACKLOG_ALERT_THRESHOLD = 5;

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}

// ── Main sweep (called by cron every 2 minutes) ─────────────────

export const sweep = internalMutation({
  args: {
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();

    await releaseRetries(ctx, now);
    await expireDecisions(ctx, now);
    await reclaimExpiredClaims(ctx, now);
    await loadShed(ctx, now);
  },
});

// ── 1. Release retries (§10.3) ──────────────────────────────────

async function releaseRetries(
  ctx: { db: any; runMutation: any },
  now: number,
) {
  const retryCards = await ctx.db
    .query("cards")
    .filter((q: any) =>
      q.eq(q.field("state"), "RETRY_SCHEDULED"),
    )
    .collect();

  for (const card of retryCards) {
    if (card.retryAtTs !== undefined && card.retryAtTs <= now) {
      await ctx.runMutation(internal.cards.transitionCard, {
        cardId: card.cardId,
        to: "READY",
        reason: "retry timer fired",
        correlationId: card.cardId,
      });
    }
  }
}

// ── 2. Expire decisions (§6.4) ──────────────────────────────────

async function expireDecisions(
  ctx: { db: any; runMutation: any },
  now: number,
) {
  const openDecisions = await ctx.db
    .query("decisions")
    .filter((q: any) =>
      q.or(
        q.eq(q.field("state"), "PENDING"),
        q.eq(q.field("state"), "CLAIMED"),
      ),
    )
    .collect();

  const expired = openDecisions.filter(
    (d: any) => d.expiresAt !== undefined && d.expiresAt <= now,
  );

  for (const decision of expired) {
    // Emit DecisionExpired
    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: decision.tenantId,
      projectId: decision.projectId,
      type: "DecisionExpired",
      version: 1,
      ts: now,
      correlationId: decision.commandId,
      commandId: decision.commandId,
      runId: decision.runId,
      cardId: decision.cardId,
      decisionId: decision.decisionId,
      producer: { service: "clawops-sweeper", version: "0.1.0" },
      payload: {
        expiresAt: decision.expiresAt,
        hadFallback: decision.fallbackOption !== undefined,
      },
    });

    if (decision.fallbackOption !== undefined) {
      // Auto-resolve with fallback option
      await ctx.db.patch(decision._id, {
        state: "RENDERED",
        renderedOption: decision.fallbackOption,
        renderedBy: "system:sweeper",
        renderedAt: now,
        claimedBy: undefined,
        claimedUntil: undefined,
      });

      await ctx.runMutation(internal.events.appendEvent, {
        eventId: generateId("evt"),
        tenantId: decision.tenantId,
        projectId: decision.projectId,
        type: "DecisionRendered",
        version: 1,
        ts: now,
        correlationId: decision.commandId,
        commandId: decision.commandId,
        runId: decision.runId,
        cardId: decision.cardId,
        decisionId: decision.decisionId,
        producer: { service: "clawops-sweeper", version: "0.1.0" },
        payload: {
          selectedOption: decision.fallbackOption,
          renderedBy: "system:sweeper",
          note: "auto-resolved via fallback on expiration",
        },
      });

      // Transition card back to RUNNING if it's in NEEDS_DECISION
      const card = await ctx.db
        .query("cards")
        .withIndex("by_cardId", (q: any) =>
          q.eq("cardId", decision.cardId),
        )
        .unique();

      if (card && card.state === "NEEDS_DECISION") {
        await ctx.runMutation(internal.cards.transitionCard, {
          cardId: decision.cardId,
          to: "RUNNING",
          reason: "decision expired, fallback applied",
          correlationId: decision.commandId,
          commandId: decision.commandId,
          runId: decision.runId,
          decisionId: decision.decisionId,
        });
      }
    } else {
      // No fallback — mark decision EXPIRED, fail the card
      await ctx.db.patch(decision._id, {
        state: "EXPIRED",
        claimedBy: undefined,
        claimedUntil: undefined,
      });

      const card = await ctx.db
        .query("cards")
        .withIndex("by_cardId", (q: any) =>
          q.eq("cardId", decision.cardId),
        )
        .unique();

      if (card && card.state === "NEEDS_DECISION") {
        await ctx.runMutation(internal.cards.transitionCard, {
          cardId: decision.cardId,
          to: "FAILED",
          reason: "decision expired, no fallback",
          correlationId: decision.commandId,
          commandId: decision.commandId,
          runId: decision.runId,
          decisionId: decision.decisionId,
        });
      }
    }
  }
}

// ── 3. Reclaim expired claims (§6.6) ────────────────────────────

async function reclaimExpiredClaims(
  ctx: { db: any; runMutation: any },
  now: number,
) {
  const claimedDecisions = await ctx.db
    .query("decisions")
    .filter((q: any) => q.eq(q.field("state"), "CLAIMED"))
    .collect();

  const expiredClaims = claimedDecisions.filter(
    (d: any) => d.claimedUntil !== undefined && d.claimedUntil < now,
  );

  for (const decision of expiredClaims) {
    const previousClaimedBy = decision.claimedBy;

    await ctx.db.patch(decision._id, {
      state: "PENDING",
      claimedBy: undefined,
      claimedUntil: undefined,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: generateId("evt"),
      tenantId: decision.tenantId,
      projectId: decision.projectId,
      type: "DecisionClaimExpired",
      version: 1,
      ts: now,
      correlationId: decision.commandId,
      commandId: decision.commandId,
      runId: decision.runId,
      cardId: decision.cardId,
      decisionId: decision.decisionId,
      producer: { service: "clawops-sweeper", version: "0.1.0" },
      payload: {
        previousClaimedBy,
        claimedUntil: decision.claimedUntil,
      },
    });
  }
}

// ── 4. Load shedding (§12.4) ────────────────────────────────────

async function loadShed(
  ctx: { db: any; runMutation: any },
  now: number,
) {
  // Count "now" urgency decisions that are PENDING or CLAIMED
  const pendingNow = await ctx.db
    .query("decisions")
    .filter((q: any) =>
      q.and(
        q.or(
          q.eq(q.field("state"), "PENDING"),
          q.eq(q.field("state"), "CLAIMED"),
        ),
        q.eq(q.field("urgency"), "now"),
      ),
    )
    .collect();

  // Group by project
  const nowBacklog = new Map<string, number>();
  for (const d of pendingNow) {
    nowBacklog.set(d.projectId, (nowBacklog.get(d.projectId) ?? 0) + 1);
  }

  for (const [projectId, count] of nowBacklog) {
    // Emergency alert
    if (count > NOW_BACKLOG_ALERT_THRESHOLD) {
      console.error(
        `[EMERGENCY] Project ${projectId}: ${count} "now" decisions in backlog`,
      );
    }

    // Defer "whenever" decisions
    if (count > NOW_BACKLOG_DEFER_THRESHOLD) {
      const wheneverDecisions = await ctx.db
        .query("decisions")
        .withIndex("by_projectId_state_urgency", (q: any) =>
          q
            .eq("projectId", projectId)
            .eq("state", "PENDING")
            .eq("urgency", "whenever"),
        )
        .collect();

      for (const decision of wheneverDecisions) {
        if (decision.fallbackOption !== undefined) {
          // Auto-resolve with fallback
          await ctx.db.patch(decision._id, {
            state: "RENDERED",
            renderedOption: decision.fallbackOption,
            renderedBy: "system:sweeper",
            renderedAt: now,
          });

          await ctx.runMutation(internal.events.appendEvent, {
            eventId: generateId("evt"),
            tenantId: decision.tenantId,
            projectId: decision.projectId,
            type: "DecisionDeferred",
            version: 1,
            ts: now,
            correlationId: decision.commandId,
            commandId: decision.commandId,
            runId: decision.runId,
            cardId: decision.cardId,
            decisionId: decision.decisionId,
            producer: { service: "clawops-sweeper", version: "0.1.0" },
            payload: {
              reason: "load_shedding",
              originalUrgency: "whenever",
              action: "auto_resolved_with_fallback",
              nowBacklog: count,
            },
          });

          await ctx.runMutation(internal.events.appendEvent, {
            eventId: generateId("evt"),
            tenantId: decision.tenantId,
            projectId: decision.projectId,
            type: "DecisionRendered",
            version: 1,
            ts: now,
            correlationId: decision.commandId,
            commandId: decision.commandId,
            runId: decision.runId,
            cardId: decision.cardId,
            decisionId: decision.decisionId,
            producer: { service: "clawops-sweeper", version: "0.1.0" },
            payload: {
              selectedOption: decision.fallbackOption,
              renderedBy: "system:sweeper",
              note: "auto-resolved via load shedding",
            },
          });

          // Transition card if in NEEDS_DECISION
          const card = await ctx.db
            .query("cards")
            .withIndex("by_cardId", (q: any) =>
              q.eq("cardId", decision.cardId),
            )
            .unique();

          if (card && card.state === "NEEDS_DECISION") {
            await ctx.runMutation(internal.cards.transitionCard, {
              cardId: decision.cardId,
              to: "RUNNING",
              reason: "decision deferred, fallback applied",
              correlationId: decision.commandId,
              commandId: decision.commandId,
              runId: decision.runId,
              decisionId: decision.decisionId,
            });
          }
        } else {
          // No fallback — extend expiresAt by 24h
          const newExpiresAt = (decision.expiresAt ?? now) + DEFER_EXTENSION_MS;
          await ctx.db.patch(decision._id, {
            expiresAt: newExpiresAt,
          });

          await ctx.runMutation(internal.events.appendEvent, {
            eventId: generateId("evt"),
            tenantId: decision.tenantId,
            projectId: decision.projectId,
            type: "DecisionDeferred",
            version: 1,
            ts: now,
            correlationId: decision.commandId,
            commandId: decision.commandId,
            runId: decision.runId,
            cardId: decision.cardId,
            decisionId: decision.decisionId,
            producer: { service: "clawops-sweeper", version: "0.1.0" },
            payload: {
              reason: "load_shedding",
              originalUrgency: "whenever",
              action: "extended_expiry",
              newExpiresAt,
              nowBacklog: count,
            },
          });
        }
      }
    }
  }
}
