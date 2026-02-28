import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

// ── Test helpers ────────────────────────────────────────────────

const TENANT_ID = "tenant_test";
const PROJECT_A = "proj_a";
const PROJECT_B = "proj_b";

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject });
}

async function setupProject(
  t: ReturnType<typeof convexTest>,
  userId: string,
  projectId: string = PROJECT_A,
) {
  const user = asUser(t, userId);
  await user.mutation(api.projectSetup.initProject, {
    tenantId: TENANT_ID,
    projectId,
    name: `Project ${projectId}`,
  });
  return user;
}

async function addMember(
  t: ReturnType<typeof convexTest>,
  ownerSubject: string,
  userId: string,
  role: "operator" | "viewer" | "bot",
  projectId: string = PROJECT_A,
) {
  const owner = asUser(t, ownerSubject);
  await owner.mutation(api.projectMembers.addMember, {
    projectId,
    userId,
    role,
  });
}

const BASE_DECISION = {
  projectId: PROJECT_A,
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

const BASE_CARD = {
  projectId: PROJECT_A,
  commandId: "cmd_test",
  correlationId: "corr_test",
  title: "Test card",
  priority: 50,
  spec: { commandType: "test.run" },
};

// ── 1. Unauthenticated rejection ────────────────────────────────

describe("unauthenticated rejection", () => {
  it("rejects mutation without identity", async () => {
    const t = convexTest(schema, modules);
    // No identity — call as anonymous
    await expect(
      t.mutation(api.cards.createCard, BASE_CARD),
    ).rejects.toThrow("Unauthenticated");
  });

  it("rejects query without identity", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.cards.cardsByState, {
        projectId: PROJECT_A,
        state: "READY",
      }),
    ).rejects.toThrow("Unauthenticated");
  });

  it("rejects initProject without identity", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.projectSetup.initProject, {
        tenantId: TENANT_ID,
        projectId: PROJECT_A,
        name: "Test",
      }),
    ).rejects.toThrow("Unauthenticated");
  });
});

// ── 2. Non-member rejection ─────────────────────────────────────

describe("non-member rejection", () => {
  it("rejects authenticated user who is not a project member", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");

    const bob = asUser(t, "user:bob");
    await expect(
      bob.mutation(api.cards.createCard, BASE_CARD),
    ).rejects.toThrow("Not a member of this project");
  });

  it("rejects query from non-member", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");

    const bob = asUser(t, "user:bob");
    await expect(
      bob.query(api.cards.cardsByState, {
        projectId: PROJECT_A,
        state: "READY",
      }),
    ).rejects.toThrow("Not a member of this project");
  });
});

// ── 3. Role-based access ────────────────────────────────────────

describe("role-based access", () => {
  it("viewer cannot create cards (requires bot/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.mutation(api.cards.createCard, BASE_CARD),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("viewer cannot request decisions (requires bot/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.mutation(api.decisions.requestDecision, BASE_DECISION),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("viewer cannot render decisions (requires operator/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.mutation(api.decisions.renderDecision, {
        projectId: PROJECT_A,
        decisionId: "dec_fake",
        optionKey: "approve",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("bot cannot render decisions (requires operator/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:bot", "bot");

    const bot = asUser(t, "user:bot");
    await expect(
      bot.mutation(api.decisions.renderDecision, {
        projectId: PROJECT_A,
        decisionId: "dec_fake",
        optionKey: "approve",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("bot cannot claim decisions (requires operator/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:bot", "bot");

    const bot = asUser(t, "user:bot");
    await expect(
      bot.mutation(api.decisions.claimDecision, {
        projectId: PROJECT_A,
        decisionId: "dec_fake",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("operator can claim and render decisions", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    // Owner creates a decision
    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    const operator = asUser(t, "user:operator");

    // Operator can claim
    const claimResult = await operator.mutation(api.decisions.claimDecision, {
      projectId: PROJECT_A,
      decisionId,
    });
    expect(claimResult.status).toBe("claimed");

    // Operator can render
    const renderResult = await operator.mutation(
      api.decisions.renderDecision,
      {
        projectId: PROJECT_A,
        decisionId,
        optionKey: "approve",
      },
    );
    expect(renderResult.status).toBe("rendered");
  });

  it("bot can create cards and request decisions", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:bot", "bot");

    const bot = asUser(t, "user:bot");

    const { cardId } = await bot.mutation(api.cards.createCard, BASE_CARD);
    expect(cardId).toBeTruthy();

    const { decisionId } = await bot.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );
    expect(decisionId).toBeTruthy();
  });

  it("viewer can read cards and decisions", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:viewer", "viewer");

    // Owner creates data
    await alice.mutation(api.cards.createCard, BASE_CARD);
    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    const viewer = asUser(t, "user:viewer");

    // Viewer can query
    const cards = await viewer.query(api.cards.cardsByState, {
      projectId: PROJECT_A,
      state: "READY",
    });
    expect(cards.length).toBeGreaterThan(0);

    const detail = await viewer.query(api.decisions.decisionDetail, {
      projectId: PROJECT_A,
      decisionId,
    });
    expect(detail).not.toBeNull();
    expect(detail!.decisionId).toBe(decisionId);
  });

  it("operator cannot create cards (requires bot/owner)", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    const operator = asUser(t, "user:operator");
    await expect(
      operator.mutation(api.cards.createCard, BASE_CARD),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("operator can request commands", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    const operator = asUser(t, "user:operator");
    const result = await operator.mutation(api.commands.requestCommand, {
      projectId: PROJECT_A,
      correlationId: "corr_test",
      title: "Test command",
      commandSpec: { commandType: "test.run" },
    });
    expect(result.commandId).toBeTruthy();
  });
});

// ── 4. Owner bypass ─────────────────────────────────────────────

describe("owner bypass", () => {
  it("owner can do everything (even operator-only actions)", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");

    // Create card (bot/owner)
    const { cardId } = await alice.mutation(api.cards.createCard, BASE_CARD);
    expect(cardId).toBeTruthy();

    // Request decision (bot/owner)
    const { decisionId } = await alice.mutation(
      api.decisions.requestDecision,
      BASE_DECISION,
    );

    // Claim (operator/owner)
    const claimResult = await alice.mutation(api.decisions.claimDecision, {
      projectId: PROJECT_A,
      decisionId,
    });
    expect(claimResult.status).toBe("claimed");

    // Render (operator/owner)
    const renderResult = await alice.mutation(api.decisions.renderDecision, {
      projectId: PROJECT_A,
      decisionId,
      optionKey: "approve",
    });
    expect(renderResult.status).toBe("rendered");

    // Read queries (any role)
    const cards = await alice.query(api.cards.cardsByState, {
      projectId: PROJECT_A,
      state: "READY",
    });
    expect(cards).toBeDefined();
  });
});

// ── 5. Cross-project isolation ──────────────────────────────────

describe("cross-project isolation", () => {
  it("user in project A cannot access project B data", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice", PROJECT_A);
    await setupProject(t, "user:bob", PROJECT_B);

    const alice = asUser(t, "user:alice");

    // Alice should not be able to create cards in project B
    await expect(
      alice.mutation(api.cards.createCard, {
        ...BASE_CARD,
        projectId: PROJECT_B,
      }),
    ).rejects.toThrow("Not a member of this project");
  });

  it("user in project A cannot query project B data", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice", PROJECT_A);
    await setupProject(t, "user:bob", PROJECT_B);

    const alice = asUser(t, "user:alice");

    await expect(
      alice.query(api.cards.cardsByState, {
        projectId: PROJECT_B,
        state: "READY",
      }),
    ).rejects.toThrow("Not a member of this project");
  });

  it("decision detail returns null for cross-project decision", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice", PROJECT_A);
    const bob = await setupProject(t, "user:bob", PROJECT_B);

    // Bob creates a decision in project B
    const { decisionId } = await bob.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      projectId: PROJECT_B,
    });

    // Alice adds herself to project B? No — she tries to query project A's
    // decisionDetail with Bob's decisionId (cross-project resource check)
    const detail = await alice.query(api.decisions.decisionDetail, {
      projectId: PROJECT_A,
      decisionId,
    });
    expect(detail).toBeNull();
  });

  it("cannot claim a decision from another project", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice", PROJECT_A);
    const bob = await setupProject(t, "user:bob", PROJECT_B);

    // Bob creates a decision in project B
    const { decisionId } = await bob.mutation(api.decisions.requestDecision, {
      ...BASE_DECISION,
      projectId: PROJECT_B,
    });

    // Add alice as operator in project A (she already is owner),
    // but she tries to claim Bob's decision using project A credentials
    await expect(
      alice.mutation(api.decisions.claimDecision, {
        projectId: PROJECT_A,
        decisionId,
      }),
    ).rejects.toThrow("Decision not found");
  });
});

// ── 6. initProject bootstrapping ────────────────────────────────

describe("initProject bootstrapping", () => {
  it("creates project and assigns caller as owner", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");

    const role = await alice.query(api.projectMembers.getMyRole, {
      projectId: PROJECT_A,
    });
    expect(role.role).toBe("owner");
    expect(role.userId).toBe("user:alice");
  });

  it("rejects duplicate project creation", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");

    const bob = asUser(t, "user:bob");
    await expect(
      bob.mutation(api.projectSetup.initProject, {
        tenantId: TENANT_ID,
        projectId: PROJECT_A,
        name: "Duplicate",
      }),
    ).rejects.toThrow("Project already exists");
  });
});

// ── 7. Member management (owner-only) ───────────────────────────

describe("member management", () => {
  it("owner can add and remove members", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");

    // Add bob as operator
    await alice.mutation(api.projectMembers.addMember, {
      projectId: PROJECT_A,
      userId: "user:bob",
      role: "operator",
    });

    const members = await alice.query(api.projectMembers.listMembers, {
      projectId: PROJECT_A,
    });
    expect(members).toHaveLength(2);

    // Remove bob
    await alice.mutation(api.projectMembers.removeMember, {
      projectId: PROJECT_A,
      userId: "user:bob",
    });

    const membersAfter = await alice.query(api.projectMembers.listMembers, {
      projectId: PROJECT_A,
    });
    expect(membersAfter).toHaveLength(1);
  });

  it("non-owner cannot add members", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    const operator = asUser(t, "user:operator");
    await expect(
      operator.mutation(api.projectMembers.addMember, {
        projectId: PROJECT_A,
        userId: "user:newbie",
        role: "viewer",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("non-owner cannot remove members", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    const operator = asUser(t, "user:operator");
    await expect(
      operator.mutation(api.projectMembers.removeMember, {
        projectId: PROJECT_A,
        userId: "user:alice",
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("cannot remove the last owner", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");

    await expect(
      alice.mutation(api.projectMembers.removeMember, {
        projectId: PROJECT_A,
        userId: "user:alice",
      }),
    ).rejects.toThrow("Cannot remove the last owner");
  });

  it("rejects adding duplicate member", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:bob", "operator");

    await expect(
      alice.mutation(api.projectMembers.addMember, {
        projectId: PROJECT_A,
        userId: "user:bob",
        role: "viewer",
      }),
    ).rejects.toThrow("already a member");
  });
});

// ── 8. emitEvent auth ───────────────────────────────────────────

describe("emitEvent auth", () => {
  it("bot can emit events", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:bot", "bot");

    const bot = asUser(t, "user:bot");
    await bot.mutation(api.events.emitEvent, {
      projectId: PROJECT_A,
      eventId: "evt_test",
      type: "CommandRequested",
      version: 1,
      ts: Date.now(),
      correlationId: "corr_test",
      producer: { service: "test", version: "0.1.0" },
      payload: { test: true },
    });
  });

  it("viewer cannot emit events", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.mutation(api.events.emitEvent, {
        projectId: PROJECT_A,
        eventId: "evt_test",
        type: "CommandRequested",
        version: 1,
        ts: Date.now(),
        correlationId: "corr_test",
        producer: { service: "test", version: "0.1.0" },
        payload: { test: true },
      }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("operator cannot emit events", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice");
    await addMember(t, "user:alice", "user:operator", "operator");

    const operator = asUser(t, "user:operator");
    await expect(
      operator.mutation(api.events.emitEvent, {
        projectId: PROJECT_A,
        eventId: "evt_test",
        type: "CommandRequested",
        version: 1,
        ts: Date.now(),
        correlationId: "corr_test",
        producer: { service: "test", version: "0.1.0" },
        payload: { test: true },
      }),
    ).rejects.toThrow("Insufficient permissions");
  });
});
