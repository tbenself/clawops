import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

// ── Test helpers ────────────────────────────────────────────────

const TENANT_ID = "tenant_test";
const PROJECT_ID = "proj_test";

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject });
}

async function setupProject(t: ReturnType<typeof convexTest>) {
  const alice = asUser(t, "user:alice");
  await alice.mutation(api.projectSetup.initProject, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: "Test Project",
  });
  return alice;
}

// ── End-to-end integration test (§17 worked example) ────────────

describe("adapter end-to-end", () => {
  it("full bot lifecycle: command → artifact → decision → render → awaitDecision", async () => {
    const t = convexTest(schema, modules);
    const owner = await setupProject(t);

    // Add bot and operator
    await owner.mutation(api.projectMembers.addMember, {
      projectId: PROJECT_ID,
      userId: "user:bot",
      role: "bot",
    });
    await owner.mutation(api.projectMembers.addMember, {
      projectId: PROJECT_ID,
      userId: "user:operator",
      role: "operator",
    });

    const bot = asUser(t, "user:bot");
    const operator = asUser(t, "user:operator");

    // 1. Bot requests a command (creates card in READY)
    const { commandId, cardId } = await bot.mutation(
      api.adapter.requestCommand,
      {
        projectId: PROJECT_ID,
        correlationId: "corr_digest",
        title: "Weekly digest compile + publish",
        commandSpec: {
          commandType: "digest.compile",
          constraints: { priority: 30 },
        },
        idempotencyKey: "digest-compile-2026-w09",
      },
    );

    expect(commandId).toMatch(/^cmd_/);
    expect(cardId).toMatch(/^card_/);

    // Verify card is READY
    const readyCards = await bot.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(readyCards.some((c: { cardId: string }) => c.cardId === cardId)).toBe(true);

    // 2. Simulate workpool picking up the job: READY → RUNNING
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "claimed by workpool",
      correlationId: "corr_digest",
      commandId,
    });

    // 3. Bot reports artifacts
    const digestResult = await bot.action(api.adapter.reportArtifact, {
      projectId: PROJECT_ID,
      content: "# Weekly Digest 2026-W09\n\n12 articles compiled.",
      encoding: "utf8",
      type: "text/markdown",
      logicalName: "digest-2026-w09.md",
      commandId,
      runId: "run_1",
      correlationId: "corr_digest",
    });
    expect(digestResult.artifactId).toMatch(/^art_/);

    const flagsResult = await bot.action(api.adapter.reportArtifact, {
      projectId: PROJECT_ID,
      content: JSON.stringify([
        { article: "Old news", reason: "potentially outdated" },
      ]),
      encoding: "utf8",
      type: "application/json",
      logicalName: "flagged-items.json",
      commandId,
      runId: "run_1",
      correlationId: "corr_digest",
    });
    expect(flagsResult.artifactId).toMatch(/^art_/);

    // 4. Bot requests a decision
    const { decisionId } = await bot.mutation(api.adapter.requestDecision, {
      projectId: PROJECT_ID,
      cardId,
      commandId,
      runId: "run_1",
      correlationId: "corr_digest",
      title: "Approve weekly digest for publishing",
      contextSummary:
        "DigestBot compiled 12 articles. 1 flagged as potentially outdated.",
      options: [
        { key: "approve", label: "Approve", consequence: "Publish as-is" },
        { key: "edit", label: "Edit", consequence: "Return for editing" },
        { key: "reject", label: "Reject", consequence: "Discard digest" },
      ],
      urgency: "today",
      artifactRefs: [digestResult.artifactId, flagsResult.artifactId],
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      fallbackOption: "reject",
    });

    expect(decisionId).toMatch(/^dec_/);

    // 5. Transition card to NEEDS_DECISION
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "awaiting human approval",
      correlationId: "corr_digest",
      commandId,
      runId: "run_1",
      decisionId,
    });

    // 6. Bot polls — decision should be pending
    const pending = await bot.query(api.adapter.awaitDecision, {
      projectId: PROJECT_ID,
      decisionId,
    });
    expect(pending!.status).toBe("pending");
    expect(pending!.selectedOption).toBeUndefined();

    // 7. Operator claims the decision
    const claimResult = await operator.mutation(api.decisions.claimDecision, {
      projectId: PROJECT_ID,
      decisionId,
    });
    expect(claimResult.status).toBe("claimed");

    // Bot sees claimed status
    const claimed = await bot.query(api.adapter.awaitDecision, {
      projectId: PROJECT_ID,
      decisionId,
    });
    expect(claimed!.status).toBe("claimed");

    // 8. Operator renders the decision
    const renderResult = await operator.mutation(api.decisions.renderDecision, {
      projectId: PROJECT_ID,
      decisionId,
      optionKey: "approve",
      note: "Looks good, publish it",
    });
    expect(renderResult.status).toBe("rendered");

    // 9. Bot sees rendered result via awaitDecision
    const rendered = await bot.query(api.adapter.awaitDecision, {
      projectId: PROJECT_ID,
      decisionId,
    });
    expect(rendered!.status).toBe("rendered");
    expect(rendered!.selectedOption).toBe("approve");
    expect(rendered!.renderedBy).toBe("user:operator");

    // 10. Verify event chain on the correlation ID
    const events = await bot.query(api.cards.eventChain, {
      projectId: PROJECT_ID,
      correlationId: "corr_digest",
    });

    const eventTypes = events.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain("CommandRequested");
    expect(eventTypes).toContain("CardCreated");
    expect(eventTypes).toContain("CardTransitioned");
    expect(eventTypes).toContain("ArtifactProduced");
    expect(eventTypes).toContain("DecisionRequested");

    // DecisionClaimed/DecisionRendered use commandId as correlationId,
    // so query by commandId to verify those events too
    const cmdEvents = await bot.query(api.cards.eventChain, {
      projectId: PROJECT_ID,
      correlationId: commandId,
    });
    const cmdEventTypes = cmdEvents.map((e: { type: string }) => e.type);
    expect(cmdEventTypes).toContain("DecisionClaimed");
    expect(cmdEventTypes).toContain("DecisionRendered");
  });
});

// ── awaitDecision edge cases ────────────────────────────────────

describe("awaitDecision", () => {
  it("returns null for unknown decisionId", async () => {
    const t = convexTest(schema, modules);
    const owner = await setupProject(t);

    const result = await owner.query(api.adapter.awaitDecision, {
      projectId: PROJECT_ID,
      decisionId: "dec_nonexistent",
    });
    expect(result).toBeNull();
  });

  it("returns null for cross-project decision", async () => {
    const t = convexTest(schema, modules);
    const owner = await setupProject(t);

    // Create a decision in this project
    const { decisionId } = await owner.mutation(api.decisions.requestDecision, {
      projectId: PROJECT_ID,
      cardId: "card_1",
      commandId: "cmd_1",
      runId: "run_1",
      correlationId: "corr_1",
      urgency: "today",
      title: "Test",
      options: [{ key: "ok", label: "OK", consequence: "OK" }],
    });

    // Set up a second project and try to query from there
    const bob = asUser(t, "user:bob");
    await bob.mutation(api.projectSetup.initProject, {
      tenantId: TENANT_ID,
      projectId: "proj_other",
      name: "Other Project",
    });

    const result = await bob.query(api.adapter.awaitDecision, {
      projectId: "proj_other",
      decisionId,
    });
    expect(result).toBeNull();
  });

  it("shows expired status", async () => {
    const t = convexTest(schema, modules);
    const owner = await setupProject(t);

    const expiresAt = Date.now() + 1_000;
    const { decisionId } = await owner.mutation(api.decisions.requestDecision, {
      projectId: PROJECT_ID,
      cardId: "card_1",
      commandId: "cmd_1",
      runId: "run_1",
      correlationId: "corr_1",
      urgency: "today",
      title: "Will expire",
      options: [{ key: "ok", label: "OK", consequence: "OK" }],
      expiresAt,
    });

    // Sweep to expire it
    await t.mutation(internal.sweeper.sweep, { now: expiresAt + 1 });

    const result = await owner.query(api.adapter.awaitDecision, {
      projectId: PROJECT_ID,
      decisionId,
    });
    expect(result!.status).toBe("expired");
  });

  it("viewer cannot poll awaitDecision (requires bot/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t);
    await owner_addMember(t, "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.query(api.adapter.awaitDecision, {
        projectId: PROJECT_ID,
        decisionId: "dec_any",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });
});

async function owner_addMember(
  t: ReturnType<typeof convexTest>,
  userId: string,
  role: "operator" | "viewer" | "bot",
) {
  const owner = asUser(t, "user:alice");
  await owner.mutation(api.projectMembers.addMember, {
    projectId: PROJECT_ID,
    userId,
    role,
  });
}
