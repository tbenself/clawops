import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

// ── Test helpers ────────────────────────────────────────────────

const BASE_DECISION = {
  tenantId: "tenant_test",
  projectId: "proj_test",
  cardId: "card_test",
  commandId: "cmd_test",
  runId: "run_test",
  correlationId: "corr_test",
  urgency: "today" as const,
  title: "Approve test artifact",
  options: [
    { key: "approve", label: "Approve", consequence: "Publishes" },
    { key: "reject", label: "Reject", consequence: "Archives" },
  ],
};

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject });
}

// ── requestDecision ─────────────────────────────────────────────

describe("requestDecision", () => {
  it("creates a PENDING decision and emits DecisionRequested", async () => {
    const t = convexTest(schema, modules);
    const as = asUser(t, "user:alice");

    const result = await as.mutation(api.decisions.requestDecision, BASE_DECISION);

    expect(result.decisionId).toMatch(/^dec_/);
    expect(result._id).toBeDefined();

    // Verify decision is in PENDING state
    const detail = await as.query(api.decisions.decisionDetail, {
      decisionId: result.decisionId,
    });
    expect(detail).not.toBeNull();
    expect(detail!.state).toBe("PENDING");
    expect(detail!.title).toBe("Approve test artifact");

    // Verify DecisionRequested event was emitted
    const events = await t.query(internal.events.listByType, {
      type: "DecisionRequested",
    });
    expect(events).toHaveLength(1);
    expect(events[0].decisionId).toBe(result.decisionId);
  });

  it("rejects decision with no options", async () => {
    const t = convexTest(schema, modules);
    const as = asUser(t, "user:alice");

    await expect(
      as.mutation(api.decisions.requestDecision, {
        ...BASE_DECISION,
        options: [],
      }),
    ).rejects.toThrow("at least one option");
  });

  it("rejects fallbackOption that doesn't match an option key", async () => {
    const t = convexTest(schema, modules);
    const as = asUser(t, "user:alice");

    await expect(
      as.mutation(api.decisions.requestDecision, {
        ...BASE_DECISION,
        fallbackOption: "nonexistent",
      }),
    ).rejects.toThrow('fallbackOption "nonexistent" must match an option key');
  });
});

// ── claimDecision ───────────────────────────────────────────────

describe("claimDecision", () => {
  it("claims a PENDING decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    const result = await alice.mutation(api.decisions.claimDecision, {
      decisionId,
    });

    expect(result.status).toBe("claimed");
    expect(result.claimedUntil).toBeGreaterThan(Date.now());
  });

  it("rejects claim by another operator on an active claim", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");
    const bob = asUser(t, "user:bob");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    const result = await bob.mutation(api.decisions.claimDecision, {
      decisionId,
    });

    expect(result.status).toBe("already_claimed");
    expect(result.claimedBy).toBe("user:alice");
  });

  it("allows re-claim by the same operator", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });
    const result = await alice.mutation(api.decisions.claimDecision, {
      decisionId,
    });

    expect(result.status).toBe("claimed");
  });

  it("rejects claim on already-rendered decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
    });

    await expect(
      alice.mutation(api.decisions.claimDecision, { decisionId }),
    ).rejects.toThrow("Cannot claim decision in state RENDERED");
  });

  it("rejects unauthenticated claim", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    // No identity
    await expect(
      t.mutation(api.decisions.claimDecision, { decisionId }),
    ).rejects.toThrow("Authentication required");
  });

  it("emits DecisionClaimed event", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    const events = await t.query(internal.events.listByType, {
      type: "DecisionClaimed",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.claimedBy).toBe("user:alice");
  });
});

// ── renewDecisionClaim ──────────────────────────────────────────

describe("renewDecisionClaim", () => {
  it("extends claim for the owning operator", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });
    const result = await alice.mutation(api.decisions.renewDecisionClaim, {
      decisionId,
    });

    expect(result.claimedUntil).toBeGreaterThan(Date.now());
  });

  it("rejects renewal by a different operator", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");
    const bob = asUser(t, "user:bob");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    await expect(
      bob.mutation(api.decisions.renewDecisionClaim, { decisionId }),
    ).rejects.toThrow("not claimed by you");
  });

  it("rejects renewal on unclaimed decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await expect(
      alice.mutation(api.decisions.renewDecisionClaim, { decisionId }),
    ).rejects.toThrow("not claimed by you");
  });

  it("does not emit an event", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    const eventsBefore = await t.query(internal.events.listByType, {
      type: "DecisionClaimed",
    });

    await alice.mutation(api.decisions.renewDecisionClaim, { decisionId });

    const eventsAfter = await t.query(internal.events.listByType, {
      type: "DecisionClaimed",
    });

    // No new events from renewal
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

// ── renderDecision (CAS) ────────────────────────────────────────

describe("renderDecision", () => {
  it("renders a PENDING decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    const result = await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
      note: "Looks good",
    });

    expect(result.status).toBe("rendered");
    expect(result.optionKey).toBe("approve");

    // Verify state updated
    const detail = await alice.query(api.decisions.decisionDetail, {
      decisionId,
    });
    expect(detail!.state).toBe("RENDERED");
    expect(detail!.renderedOption).toBe("approve");
    expect(detail!.renderedBy).toBe("user:alice");

    // Verify DecisionRendered event
    const events = await t.query(internal.events.listByType, {
      type: "DecisionRendered",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.selectedOption).toBe("approve");
  });

  it("renders a CLAIMED decision by the claim owner", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    const result = await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "reject",
    });

    expect(result.status).toBe("rendered");

    // Claim fields should be cleared
    const detail = await alice.query(api.decisions.decisionDetail, {
      decisionId,
    });
    expect(detail!.claimedBy).toBeUndefined();
    expect(detail!.claimedUntil).toBeUndefined();
  });

  it("rejects render of already-rendered decision (race condition)", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");
    const bob = asUser(t, "user:bob");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    // Alice renders first
    await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
    });

    // Bob tries to render — gets rejection status (not thrown error)
    const result = await bob.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "reject",
    });

    expect(result.status).toBe("rejected");

    // Verify DecisionRenderRejected event was committed
    const rejected = await t.query(internal.events.listByType, {
      type: "DecisionRenderRejected",
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.attemptedBy).toBe("user:bob");
    expect(rejected[0].payload.attemptedOption).toBe("reject");
    expect(rejected[0].payload.currentState).toBe("RENDERED");
  });

  it("rejects render by non-claimant on a CLAIMED decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");
    const bob = asUser(t, "user:bob");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.claimDecision, { decisionId });

    const result = await bob.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
    });

    expect(result.status).toBe("rejected");

    // Verify rejection event was committed
    const rejected = await t.query(internal.events.listByType, {
      type: "DecisionRenderRejected",
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.reason).toBe("claimed_by_another");
  });

  it("rejects invalid option key", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await expect(
      alice.mutation(api.decisions.renderDecision, {
        decisionId,
        optionKey: "nonexistent",
      }),
    ).rejects.toThrow('Invalid option key "nonexistent"');
  });

  it("rejects unauthenticated render", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await expect(
      t.mutation(api.decisions.renderDecision, {
        decisionId,
        optionKey: "approve",
      }),
    ).rejects.toThrow("Authentication required");
  });

  it("exactly one DecisionRendered event per decision", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");
    const bob = asUser(t, "user:bob");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    // Alice renders
    await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
    });

    // Bob tries — gets rejected
    const result = await bob.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "reject",
    });
    expect(result.status).toBe("rejected");

    // Only one DecisionRendered
    const rendered = await t.query(internal.events.listByType, {
      type: "DecisionRendered",
    });
    expect(rendered).toHaveLength(1);
  });
});

// ── pendingDecisions ────────────────────────────────────────────

describe("pendingDecisions", () => {
  it("returns PENDING and CLAIMED decisions sorted by urgency", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    // Create decisions with different urgencies
    await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "whenever",
      title: "Low priority",
    });
    const { decisionId: urgentId } = await alice.mutation(
      api.decisions.requestDecision,
      {
        ...BASE_DECISION,
        urgency: "now",
        title: "Urgent",
        commandId: "cmd_2",
      },
    );
    await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "today",
      title: "Medium",
      commandId: "cmd_3",
    });

    // Claim the urgent one
    await alice.mutation(api.decisions.claimDecision, {
      decisionId: urgentId,
    });

    const result = await alice.query(api.decisions.pendingDecisions, {
      projectId: "proj_test",
    });

    expect(result).toHaveLength(3);
    // now first, then today, then whenever
    expect(result[0].urgency).toBe("now");
    expect(result[1].urgency).toBe("today");
    expect(result[2].urgency).toBe("whenever");
  });

  it("excludes rendered decisions", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    await alice.mutation(api.decisions.renderDecision, {
      decisionId,
      optionKey: "approve",
    });

    const result = await alice.query(api.decisions.pendingDecisions, {
      projectId: "proj_test",
    });

    expect(result).toHaveLength(0);
  });

  it("filters by urgency when provided", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "now",
      title: "Urgent",
    });
    await alice.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      urgency: "today",
      title: "Normal",
      commandId: "cmd_2",
    });

    const result = await alice.query(api.decisions.pendingDecisions, {
      projectId: "proj_test",
      urgency: "now",
    });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Urgent");
  });
});

// ── decisionDetail ──────────────────────────────────────────────

describe("decisionDetail", () => {
  it("returns full decision with context bundle", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    const detail = await alice.query(api.decisions.decisionDetail, {
      decisionId,
    });

    expect(detail).not.toBeNull();
    expect(detail!.decisionId).toBe(decisionId);
    expect(detail!.options).toHaveLength(2);
    expect(detail!.context).toBeDefined();
    expect(detail!.context.eventChain).toBeDefined();
  });

  it("returns null for unknown decisionId", async () => {
    const t = convexTest(schema, modules);
    const alice = asUser(t, "user:alice");

    const detail = await alice.query(api.decisions.decisionDetail, {
      decisionId: "dec_nonexistent",
    });

    expect(detail).toBeNull();
  });
});
