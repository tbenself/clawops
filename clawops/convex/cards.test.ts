import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

// ── Test helpers ────────────────────────────────────────────────

const PROJECT_ID = "proj_test";
const TENANT_ID = "tenant_test";

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject });
}

async function setupProject(
  t: ReturnType<typeof convexTest>,
  userId = "user:alice",
  projectId = PROJECT_ID,
) {
  const user = asUser(t, userId);
  await user.mutation(api.projectSetup.initProject, {
    tenantId: TENANT_ID,
    projectId,
    name: "Test Project",
  });
  return user;
}

const BASE_CARD = {
  projectId: PROJECT_ID,
  commandId: "cmd_test",
  correlationId: "corr_test",
  title: "Test card",
  priority: 50,
  spec: {
    commandType: "test.run",
    args: { source: "unit" },
  },
};

const BASE_COMMAND = {
  projectId: PROJECT_ID,
  correlationId: "corr_test",
  title: "Test command",
  commandSpec: {
    commandType: "notes.sync",
    args: { source: "exports" },
    constraints: {
      priority: 30,
      concurrencyKey: "notes-sync",
      maxRetries: 3,
    },
  },
};

// ── createCard ──────────────────────────────────────────────────

describe("createCard", () => {
  it("creates a card in READY state and emits CardCreated", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const result = await alice.mutation(api.cards.createCard, BASE_CARD);

    expect(result.cardId).toMatch(/^card_/);
    expect(result._id).toBeDefined();

    // Verify card is in READY state
    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe(result.cardId);
    expect(cards[0].state).toBe("READY");
    expect(cards[0].attempt).toBe(0);
    expect(cards[0].title).toBe("Test card");

    // Verify CardCreated event
    const events = await t.query(internal.events.listByType, {
      type: "CardCreated",
    });
    expect(events).toHaveLength(1);
    expect(events[0].cardId).toBe(result.cardId);
    expect(events[0].payload.title).toBe("Test card");
  });
});

// ── transitionCard ──────────────────────────────────────────────

describe("transitionCard", () => {
  it("allows READY → RUNNING and increments attempt", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);

    const result = await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
      commandId: "cmd_test",
    });

    expect(result.from).toBe("READY");
    expect(result.to).toBe("RUNNING");

    // Verify state and attempt
    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "RUNNING",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].attempt).toBe(1);

    // Verify CardTransitioned event
    const events = await t.query(internal.events.listByType, {
      type: "CardTransitioned",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.from).toBe("READY");
    expect(events[0].payload.to).toBe("RUNNING");
  });

  it("allows RUNNING → DONE", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "DONE",
      reason: "command succeeded",
      correlationId: "corr_test",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "DONE",
    });
    expect(cards).toHaveLength(1);
  });

  it("allows RUNNING → NEEDS_DECISION", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "decision requested",
      correlationId: "corr_test",
      decisionId: "dec_test",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "NEEDS_DECISION",
    });
    expect(cards).toHaveLength(1);
  });

  it("allows NEEDS_DECISION → RUNNING after decision rendered", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "decision requested",
      correlationId: "corr_test",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "decision rendered",
      correlationId: "corr_test",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "RUNNING",
    });
    expect(cards).toHaveLength(1);
    // Attempt increments each time entering RUNNING
    expect(cards[0].attempt).toBe(2);
  });

  it("allows RUNNING → FAILED", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "FAILED",
      reason: "exhausted retries",
      correlationId: "corr_test",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "FAILED",
    });
    expect(cards).toHaveLength(1);
  });

  it("allows RUNNING → RETRY_SCHEDULED → READY", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });

    const retryAtTs = Date.now() + 60_000;
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RETRY_SCHEDULED",
      reason: "transient failure",
      correlationId: "corr_test",
      retryAtTs,
    });

    // Verify retryAtTs is set
    let cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "RETRY_SCHEDULED",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].retryAtTs).toBe(retryAtTs);

    // RETRY_SCHEDULED → READY clears retryAtTs
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "READY",
      reason: "retry timer fired",
      correlationId: "corr_test",
    });

    cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].retryAtTs).toBeUndefined();
  });

  it("allows NEEDS_DECISION → FAILED (expired, no fallback)", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "decision requested",
      correlationId: "corr_test",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "FAILED",
      reason: "decision expired, no fallback",
      correlationId: "corr_test",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "FAILED",
    });
    expect(cards).toHaveLength(1);
  });

  // ── Invalid transitions ───────────────────────────────────────

  it("rejects READY → DONE (must go through RUNNING)", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);

    await expect(
      t.mutation(internal.cards.transitionCard, {
        cardId,
        to: "DONE",
        reason: "shortcut attempt",
        correlationId: "corr_test",
      }),
    ).rejects.toThrow("Invalid card transition: READY → DONE");
  });

  it("rejects DONE → RUNNING (terminal state)", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "DONE",
      reason: "completed",
      correlationId: "corr_test",
    });

    await expect(
      t.mutation(internal.cards.transitionCard, {
        cardId,
        to: "RUNNING",
        reason: "attempt restart",
        correlationId: "corr_test",
      }),
    ).rejects.toThrow("Invalid card transition: DONE → RUNNING");
  });

  it("rejects FAILED → READY (terminal state)", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
    });
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "FAILED",
      reason: "terminal",
      correlationId: "corr_test",
    });

    await expect(
      t.mutation(internal.cards.transitionCard, {
        cardId,
        to: "READY",
        reason: "retry from failed",
        correlationId: "corr_test",
      }),
    ).rejects.toThrow("Invalid card transition: FAILED → READY");
  });

  it("rejects transition of unknown card", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.cards.transitionCard, {
        cardId: "card_nonexistent",
        to: "RUNNING",
        reason: "claim",
        correlationId: "corr_test",
      }),
    ).rejects.toThrow("Card not found");
  });
});

// ── cardsByState ────────────────────────────────────────────────

describe("cardsByState", () => {
  it("returns cards filtered by state ordered by priority", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    // Lower priority number = higher priority
    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      priority: 100,
      title: "Low priority",
    });
    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      priority: 10,
      title: "High priority",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });

    expect(cards).toHaveLength(2);
    // Index orders by priority ascending
    expect(cards[0].priority).toBe(10);
    expect(cards[1].priority).toBe(100);
  });

  it("scopes to projectId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice", "proj_1");
    await setupProject(t, "user:alice", "proj_2");

    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      projectId: "proj_1",
    });
    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      projectId: "proj_2",
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: "proj_1",
      state: "READY",
    });

    expect(cards).toHaveLength(1);
  });
});

// ── eventChain ──────────────────────────────────────────────────

describe("eventChain", () => {
  it("returns full event chain ordered by ts", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { cardId } = await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      correlationId: "corr_chain",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_chain",
    });

    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "DONE",
      reason: "command succeeded",
      correlationId: "corr_chain",
    });

    const chain = await alice.query(api.cards.eventChain, {
      projectId: PROJECT_ID,
      correlationId: "corr_chain",
    });

    // CardCreated + 2 CardTransitioned
    expect(chain).toHaveLength(3);
    expect(chain[0].type).toBe("CardCreated");
    expect(chain[1].type).toBe("CardTransitioned");
    expect(chain[2].type).toBe("CardTransitioned");
  });

  it("scopes to projectId and correlationId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      correlationId: "corr_a",
    });
    await alice.mutation(api.cards.createCard, {
      ...BASE_CARD,
      correlationId: "corr_b",
    });

    const chain = await alice.query(api.cards.eventChain, {
      projectId: PROJECT_ID,
      correlationId: "corr_a",
    });

    expect(chain).toHaveLength(1);
    expect(chain[0].type).toBe("CardCreated");
  });
});

// ── requestCommand (full automated path) ────────────────────────

describe("requestCommand", () => {
  it("creates command read model, card, and emits events", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const result = await alice.mutation(api.commands.requestCommand, BASE_COMMAND);

    expect(result.commandId).toMatch(/^cmd_/);
    expect(result.cardId).toMatch(/^card_/);

    // Verify CommandRequested event
    const cmdEvents = await t.query(internal.events.listByType, {
      type: "CommandRequested",
    });
    expect(cmdEvents).toHaveLength(1);
    expect(cmdEvents[0].commandId).toBe(result.commandId);

    // Verify CardCreated event
    const cardEvents = await t.query(internal.events.listByType, {
      type: "CardCreated",
    });
    expect(cardEvents).toHaveLength(1);
    expect(cardEvents[0].cardId).toBe(result.cardId);

    // Verify card is in READY state
    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].state).toBe("READY");
    expect(cards[0].priority).toBe(30); // from commandSpec.constraints.priority
  });

  it("full automated happy path: command → run → done", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    // 1. Request command
    const { commandId, cardId } = await alice.mutation(
      api.commands.requestCommand,
      BASE_COMMAND,
    );

    // 2. Transition card: READY → RUNNING
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
      commandId,
    });

    // 3. Transition card: RUNNING → DONE
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "DONE",
      reason: "command succeeded",
      correlationId: "corr_test",
      commandId,
    });

    // Verify final state
    const doneCards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "DONE",
    });
    expect(doneCards).toHaveLength(1);
    expect(doneCards[0].attempt).toBe(1);

    // Verify full event chain
    const chain = await alice.query(api.cards.eventChain, {
      projectId: PROJECT_ID,
      correlationId: "corr_test",
    });

    const types = chain.map((e: { type: string }) => e.type);
    expect(types).toContain("CommandRequested");
    expect(types).toContain("CardCreated");
    expect(types).toContain("CardTransitioned");
  });

  it("decision path: command → decision → resume → done", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    // 1. Request command
    const { commandId, cardId } = await alice.mutation(
      api.commands.requestCommand,
      BASE_COMMAND,
    );

    // 2. READY → RUNNING
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "executor claimed",
      correlationId: "corr_test",
      commandId,
    });

    // 3. RUNNING → NEEDS_DECISION
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "NEEDS_DECISION",
      reason: "decision requested",
      correlationId: "corr_test",
      commandId,
      decisionId: "dec_test",
    });

    // Verify blocked state
    let blocked = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "NEEDS_DECISION",
    });
    expect(blocked).toHaveLength(1);

    // 4. NEEDS_DECISION → RUNNING (decision rendered)
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "RUNNING",
      reason: "decision rendered",
      correlationId: "corr_test",
      commandId,
    });

    // 5. RUNNING → DONE
    await t.mutation(internal.cards.transitionCard, {
      cardId,
      to: "DONE",
      reason: "command succeeded",
      correlationId: "corr_test",
      commandId,
    });

    const done = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "DONE",
    });
    expect(done).toHaveLength(1);
    expect(done[0].attempt).toBe(2); // entered RUNNING twice
  });

  it("uses priority from commandSpec.constraints", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    await alice.mutation(api.commands.requestCommand, {
      ...BASE_COMMAND,
      commandSpec: {
        commandType: "high.priority",
        constraints: { priority: 5 },
      },
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(cards[0].priority).toBe(5);
  });

  it("defaults priority to 50 when not specified", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    await alice.mutation(api.commands.requestCommand, {
      ...BASE_COMMAND,
      commandSpec: {
        commandType: "no.priority",
      },
    });

    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_ID,
      state: "READY",
    });
    expect(cards[0].priority).toBe(50);
  });
});

// ── Projectors ──────────────────────────────────────────────────

describe("projectors", () => {
  describe("projectCommandEvent", () => {
    it("creates a command read model from CommandRequested", async () => {
      const t = convexTest(schema, modules);

      const result = await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandRequested",
        ts: 1000,
        commandId: "cmd_proj_1",
        payload: {
          commandSpec: {
            commandType: "test.cmd",
            constraints: { priority: 20 },
          },
        },
      });

      expect(result.created).toBe(true);
    });

    it("updates command status on CommandStarted", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandRequested",
        ts: 1000,
        commandId: "cmd_proj_2",
        payload: {
          commandSpec: { commandType: "test.cmd" },
        },
      });

      const result = await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_002",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 2000,
        commandId: "cmd_proj_2",
        runId: "run_1",
        payload: {},
      });

      expect(result.updated).toBe(true);
    });

    it("skips already-processed events (idempotent)", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandRequested",
        ts: 1000,
        commandId: "cmd_proj_3",
        payload: {
          commandSpec: { commandType: "test.cmd" },
        },
      });

      await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_002",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 2000,
        commandId: "cmd_proj_3",
        runId: "run_1",
        payload: {},
      });

      // Replay evt_001 — should be skipped
      const result = await t.mutation(internal.projectors.projectCommandEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandRequested",
        ts: 1000,
        commandId: "cmd_proj_3",
        payload: {
          commandSpec: { commandType: "test.cmd" },
        },
        replay: true,
      });

      expect(result.skipped).toBe(true);
    });
  });

  describe("projectRunEvent", () => {
    it("creates a run on CommandStarted", async () => {
      const t = convexTest(schema, modules);

      const result = await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 1000,
        commandId: "cmd_test",
        runId: "run_proj_1",
        payload: { attempt: 1 },
      });

      expect(result.created).toBe(true);
    });

    it("marks run as SUCCEEDED", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 1000,
        commandId: "cmd_test",
        runId: "run_proj_2",
        payload: { attempt: 1 },
      });

      const result = await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_002",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandSucceeded",
        ts: 2000,
        commandId: "cmd_test",
        runId: "run_proj_2",
        payload: {},
      });

      expect(result.updated).toBe(true);
    });

    it("marks run as FAILED with error", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 1000,
        commandId: "cmd_test",
        runId: "run_proj_3",
        payload: { attempt: 1 },
      });

      const result = await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_002",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandFailed",
        ts: 2000,
        commandId: "cmd_test",
        runId: "run_proj_3",
        payload: { error: { message: "timeout" } },
      });

      expect(result.updated).toBe(true);
    });

    it("skips duplicate CommandStarted (idempotent)", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 1000,
        commandId: "cmd_test",
        runId: "run_proj_4",
        payload: { attempt: 1 },
      });

      const result = await t.mutation(internal.projectors.projectRunEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CommandStarted",
        ts: 1000,
        commandId: "cmd_test",
        runId: "run_proj_4",
        payload: { attempt: 1 },
        replay: true,
      });

      expect(result.skipped).toBe(true);
    });
  });

  describe("projectCardEvent", () => {
    it("creates a card from CardCreated", async () => {
      const t = convexTest(schema, modules);

      const result = await t.mutation(internal.projectors.projectCardEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CardCreated",
        ts: 1000,
        cardId: "card_proj_1",
        payload: {
          title: "Projected card",
          priority: 25,
          spec: { commandType: "test.cmd" },
        },
      });

      expect(result.created).toBe(true);
    });

    it("updates card state on CardTransitioned", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectCardEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CardCreated",
        ts: 1000,
        cardId: "card_proj_2",
        payload: {
          title: "Projected card",
          priority: 50,
          spec: { commandType: "test.cmd" },
        },
      });

      const result = await t.mutation(internal.projectors.projectCardEvent, {
        eventId: "evt_002",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CardTransitioned",
        ts: 2000,
        cardId: "card_proj_2",
        payload: {
          from: "READY",
          to: "RUNNING",
        },
      });

      expect(result.updated).toBe(true);
    });

    it("skips duplicate CardCreated (idempotent)", async () => {
      const t = convexTest(schema, modules);

      await t.mutation(internal.projectors.projectCardEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CardCreated",
        ts: 1000,
        cardId: "card_proj_3",
        payload: {
          title: "Projected card",
          priority: 50,
          spec: { commandType: "test.cmd" },
        },
      });

      const result = await t.mutation(internal.projectors.projectCardEvent, {
        eventId: "evt_001",
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        type: "CardCreated",
        ts: 1000,
        cardId: "card_proj_3",
        payload: {
          title: "Projected card",
          priority: 50,
          spec: { commandType: "test.cmd" },
        },
        replay: true,
      });

      expect(result.skipped).toBe(true);
    });
  });
});
