import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

// ── Test helpers ────────────────────────────────────────────────

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject });
}

const BASE_CARD = {
  tenantId: "tenant_test",
  projectId: "proj_test",
  commandId: "cmd_test",
  correlationId: "corr_test",
  title: "Test card",
  priority: 50,
  spec: { commandType: "test.run" },
};

const BASE_DECISION = {
  tenantId: "tenant_test",
  projectId: "proj_test",
  cardId: "card_test",
  commandId: "cmd_test",
  runId: "run_test",
  correlationId: "corr_test",
  urgency: "today" as const,
  title: "Test decision",
  options: [
    { key: "approve", label: "Approve", consequence: "Proceed" },
    { key: "reject", label: "Reject", consequence: "Stop" },
  ],
};

// Helper: create a card and transition it to a target state
async function createCardInState(
  t: ReturnType<typeof convexTest>,
  state: "READY" | "RUNNING" | "NEEDS_DECISION" | "RETRY_SCHEDULED",
  overrides: Record<string, unknown> = {},
) {
  const alice = asUser(t, "user:alice");
  const { retryAtTs, ...cardOverrides } = overrides;
  const { cardId } = await alice.mutation(api.cards.createCard, {
    ...BASE_CARD,
    ...cardOverrides,
  });

  if (state === "READY") return cardId;

  await t.mutation(internal.cards.transitionCard, {
    cardId,
    to: "RUNNING",
    reason: "claimed",
    correlationId: "corr_test",
  });

  if (state === "RUNNING") return cardId;

  if (state === "NEEDS_DECISION") {
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "decision requested",
      correlationId: "corr_test",
    });
    return cardId;
  }

  if (state === "RETRY_SCHEDULED") {
    const retryTs = (retryAtTs as number | undefined) ?? Date.now() + 60_000;
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RETRY_SCHEDULED",
      reason: "transient failure",
      correlationId: "corr_test",
      retryAtTs: retryTs,
    });
    return cardId;
  }

  return cardId;
}

// ── 1. Release retries ──────────────────────────────────────────

describe("release retries", () => {
  it("transitions RETRY_SCHEDULED cards with past retryAtTs to READY", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const retryAtTs = Date.now() + 1_000;
    const cardId = await createCardInState(t, "RETRY_SCHEDULED", { retryAtTs });

    // Sweep at a time after retryAtTs
    await t.mutation(internal.sweeper.sweep, { now: retryAtTs + 1 });

    const readyCards = await alice.query(api.cards.cardsByState, {
      projectId: "proj_test",
      state: "READY",
    });
    expect(readyCards.some((c: { cardId: string }) => c.cardId === cardId)).toBe(true);
  });

  it("skips RETRY_SCHEDULED cards with future retryAtTs", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const retryAtTs = Date.now() + 60_000;
    const cardId = await createCardInState(t, "RETRY_SCHEDULED", { retryAtTs });

    // Sweep before retryAtTs
    await t.mutation(internal.sweeper.sweep, { now: Date.now() });

    const retryCards = await alice.query(api.cards.cardsByState, {
      projectId: "proj_test",
      state: "RETRY_SCHEDULED",
    });
    expect(retryCards.some((c: { cardId: string }) => c.cardId === cardId)).toBe(true);
  });
});

// ── 2. Expire decisions ─────────────────────────────────────────

describe("expire decisions", () => {
  it("auto-resolves expired decision with fallback", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create card in NEEDS_DECISION
    const cardId = await createCardInState(t, "NEEDS_DECISION");

    // Create decision with past expiresAt and fallback
    const expiresAt = Date.now() + 1_000;
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      cardId,
      expiresAt,
      fallbackOption: "approve",
    });

    // Sweep after expiry
    await t.mutation(internal.sweeper.sweep, { now: expiresAt + 1 });

    // Decision should be RENDERED with fallback
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("RENDERED");
    expect(detail!.renderedOption).toBe("approve");
    expect(detail!.renderedBy).toBe("system:sweeper");

    // Card should be back to RUNNING
    const runningCards = await alice.query(api.cards.cardsByState, {
      projectId: "proj_test",
      state: "RUNNING",
    });
    expect(runningCards.some((c: { cardId: string }) => c.cardId === cardId)).toBe(true);

    // DecisionExpired event should exist
    const expiredEvents = await t.query(internal.events.listByType, {
      type: "DecisionExpired",
    });
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].payload.hadFallback).toBe(true);

    // DecisionRendered event for auto-resolve
    const renderedEvents = await t.query(internal.events.listByType, {
      type: "DecisionRendered",
    });
    expect(renderedEvents).toHaveLength(1);
    expect(renderedEvents[0].payload.renderedBy).toBe("system:sweeper");
  });

  it("fails card when decision expires without fallback", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create card in NEEDS_DECISION
    const cardId = await createCardInState(t, "NEEDS_DECISION");

    // Create decision with past expiresAt, no fallback
    const expiresAt = Date.now() + 1_000;
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      cardId,
      expiresAt,
    });

    await t.mutation(internal.sweeper.sweep, { now: expiresAt + 1 });

    // Decision should be EXPIRED
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("EXPIRED");

    // Card should be FAILED
    const failedCards = await alice.query(api.cards.cardsByState, {
      projectId: "proj_test",
      state: "FAILED",
    });
    expect(failedCards.some((c: { cardId: string }) => c.cardId === cardId)).toBe(true);

    // DecisionExpired event
    const expiredEvents = await t.query(internal.events.listByType, {
      type: "DecisionExpired",
    });
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].payload.hadFallback).toBe(false);
  });

  it("skips decisions without expiresAt", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create decision without expiresAt
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
    });

    await t.mutation(internal.sweeper.sweep, { now: Date.now() + 999_999_999 });

    // Decision should still be PENDING
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("PENDING");
  });

  it("expires a CLAIMED decision (claim doesn't extend deadline)", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const cardId = await createCardInState(t, "NEEDS_DECISION");

    const expiresAt = Date.now() + 1_000;
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      cardId,
      expiresAt,
    });

    // Claim the decision (claimedUntil will be ~5 min in future)
    await alice.mutation(api.decisions.claimDecision, { decisionId });

    // Sweep after expiresAt — decision should still expire even though claimed
    await t.mutation(internal.sweeper.sweep, { now: expiresAt + 1 });

    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("EXPIRED");
  });
});

// ── 3. Reclaim expired claims ───────────────────────────────────

describe("reclaim expired claims", () => {
  it("resets expired claims to PENDING", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
    });

    // Claim it (claimedUntil = Date.now() + 5 min)
    const claimResult = await alice.mutation(api.decisions.claimDecision, {
      decisionId,
    });

    // Sweep after claim expiry
    await t.mutation(internal.sweeper.sweep, {
      now: claimResult.claimedUntil! + 1,
    });

    // Decision should be back to PENDING
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("PENDING");
    expect(detail!.claimedBy).toBeUndefined();
    expect(detail!.claimedUntil).toBeUndefined();

    // DecisionClaimExpired event
    const events = await t.query(internal.events.listByType, {
      type: "DecisionClaimExpired",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.previousClaimedBy).toBe("user:alice");
  });

  it("skips active claims (claimedUntil in future)", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
    });

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    // Sweep before claim expiry
    await t.mutation(internal.sweeper.sweep, { now: Date.now() });

    // Should still be CLAIMED
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("CLAIMED");
    expect(detail!.claimedBy).toBe("user:alice");
  });
});

// ── 4. Load shedding ────────────────────────────────────────────

describe("load shedding", () => {
  // Helper: create N "now" urgency decisions
  async function createNowDecisions(
    t: ReturnType<typeof convexTest>,
    count: number,
  ) {
    const alice = asUser(t, "user:alice");
    for (let i = 0; i < count; i++) {
      await alice.mutation(api.decisions.requestDecision, {
        ...BASE_DECISION,
        urgency: "now",
        title: `Urgent ${i}`,
        commandId: `cmd_now_${i}`,
      });
    }
  }

  it("auto-resolves 'whenever' decisions with fallback when backlog > 2", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create 3 "now" decisions (exceeds threshold of 2)
    await createNowDecisions(t, 3);

    // Create a "whenever" decision with fallback
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "whenever",
      title: "Low priority with fallback",
      commandId: "cmd_whenever_fb",
      fallbackOption: "approve",
    });

    await t.mutation(internal.sweeper.sweep, { now: Date.now() });

    // "whenever" decision should be auto-resolved
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("RENDERED");
    expect(detail!.renderedOption).toBe("approve");
    expect(detail!.renderedBy).toBe("system:sweeper");

    // DecisionDeferred event
    const deferred = await t.query(internal.events.listByType, {
      type: "DecisionDeferred",
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0].payload.reason).toBe("load_shedding");
    expect(deferred[0].payload.action).toBe("auto_resolved_with_fallback");
  });

  it("extends expiresAt for 'whenever' decisions without fallback when backlog > 2", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    await createNowDecisions(t, 3);

    // Create a "whenever" decision without fallback
    const originalExpiresAt = Date.now() + 60_000;
    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "whenever",
      title: "Low priority no fallback",
      commandId: "cmd_whenever_nofb",
      expiresAt: originalExpiresAt,
    });

    const sweepNow = Date.now();
    await t.mutation(internal.sweeper.sweep, { now: sweepNow });

    // Decision should still be PENDING but with extended expiresAt
    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("PENDING");
    // expiresAt extended by 24h
    expect(detail!.expiresAt).toBe(originalExpiresAt + 24 * 60 * 60 * 1000);

    // DecisionDeferred event
    const deferred = await t.query(internal.events.listByType, {
      type: "DecisionDeferred",
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0].payload.action).toBe("extended_expiry");
  });

  it("does not defer when backlog <= 2", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create only 2 "now" decisions (at threshold, not exceeding)
    await createNowDecisions(t, 2);

    const { decisionId } = await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "whenever",
      title: "Should not be deferred",
      commandId: "cmd_whenever_safe",
      fallbackOption: "approve",
    });

    await t.mutation(internal.sweeper.sweep, { now: Date.now() });

    const detail = await alice.query(api.decisions.decisionDetail, { decisionId });
    expect(detail!.state).toBe("PENDING");
  });

  it("logs emergency when backlog > 5", async () => {
    const t = convexTest(schema, modules);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createNowDecisions(t, 6);

    await t.mutation(internal.sweeper.sweep, { now: Date.now() });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[EMERGENCY]"),
    );

    spy.mockRestore();
  });
});
