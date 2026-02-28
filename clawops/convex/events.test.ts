import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { containsSecret } from "./events";

// ── Test helpers ────────────────────────────────────────────────

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: "tenant_test",
    projectId: "proj_test",
    type: "CommandRequested" as const,
    version: 1,
    ts: Date.now(),
    correlationId: "corr_test",
    producer: { service: "test", version: "0.1.0" },
    payload: {},
    ...overrides,
  };
}

// ── Secret denylist ─────────────────────────────────────────────

describe("containsSecret", () => {
  it("detects GitHub personal access tokens", () => {
    expect(containsSecret("ghp_FAKE0000000000000000000000000000000000")).toBe(true);
  });

  it("detects OpenAI/Stripe sk- keys", () => {
    expect(containsSecret("sk-FAKE0000000000000000000000")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(containsSecret("Bearer FAKE-TOKEN-FOR-TESTING")).toBe(true);
  });

  it("detects PEM private keys", () => {
    expect(containsSecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("detects Slack tokens", () => {
    expect(containsSecret("xoxb-test-token")).toBe(true);
  });

  it("detects AWS access keys", () => {
    expect(containsSecret("AKIAFAKE0000FORTESTS")).toBe(true);
  });

  it("detects secrets in nested objects", () => {
    expect(containsSecret({ deep: { token: "ghp_FAKE0000000000000000000000000000000000" } })).toBe(true);
  });

  it("detects secrets in arrays", () => {
    expect(containsSecret(["safe", "ghp_FAKE0000000000000000000000000000000000"])).toBe(true);
  });

  it("allows clean payloads", () => {
    expect(containsSecret("just a normal string")).toBe(false);
    expect(containsSecret({ credential_ref: "env:GITHUB_TOKEN" })).toBe(false);
    expect(containsSecret({ count: 42, items: ["a", "b"] })).toBe(false);
  });
});

// ── appendEvent: secret rejection ───────────────────────────────

describe("appendEvent", () => {
  it("rejects payloads containing secrets", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.events.appendEvent, makeEvent({
        payload: { token: "ghp_FAKE0000000000000000000000000000000000" },
      })),
    ).rejects.toThrow("Payload appears to contain a raw secret");
  });

  it("rejects tags containing secrets", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.events.appendEvent, makeEvent({
        tags: { auth: "Bearer FAKE-TOKEN-FOR-TESTING" },
      })),
    ).rejects.toThrow("Tags appear to contain a raw secret");
  });

  it("accepts clean payloads", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(
      internal.events.appendEvent,
      makeEvent({ payload: { summary: "All good" } }),
    );
    expect(id).toBeDefined();
  });

  // ── Idempotency ─────────────────────────────────────────────

  it("deduplicates events with the same idempotencyKey", async () => {
    const t = convexTest(schema);
    const event = makeEvent({ idempotencyKey: "dedup-test-1" });

    const id1 = await t.mutation(internal.events.appendEvent, event);
    const id2 = await t.mutation(internal.events.appendEvent, {
      ...event,
      eventId: "evt_different",
      payload: { changed: true },
    });

    expect(id1).toEqual(id2);
  });

  it("allows events without idempotencyKey to be duplicated", async () => {
    const t = convexTest(schema);
    const base = makeEvent();

    const id1 = await t.mutation(internal.events.appendEvent, base);
    const id2 = await t.mutation(internal.events.appendEvent, {
      ...base,
      eventId: "evt_second",
    });

    expect(id1).not.toEqual(id2);
  });

  it("allows different idempotencyKeys", async () => {
    const t = convexTest(schema);

    const id1 = await t.mutation(
      internal.events.appendEvent,
      makeEvent({ idempotencyKey: "key-a" }),
    );
    const id2 = await t.mutation(
      internal.events.appendEvent,
      makeEvent({ idempotencyKey: "key-b", eventId: "evt_other" }),
    );

    expect(id1).not.toEqual(id2);
  });
});

// ── listByCorrelationId ─────────────────────────────────────────

describe("listByCorrelationId", () => {
  it("returns events for a correlation chain ordered by ts", async () => {
    const t = convexTest(schema);
    const correlationId = "corr_chain_1";

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_1", correlationId, ts: 1000,
      type: "CommandRequested" as const,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_2", correlationId, ts: 2000,
      type: "CommandStarted" as const,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_3", correlationId: "corr_other", ts: 1500,
      type: "CardCreated" as const,
    }));

    const result = await t.query(internal.events.listByCorrelationId, {
      projectId: "proj_test",
      correlationId,
    });

    expect(result).toHaveLength(2);
    expect(result[0].eventId).toBe("evt_1");
    expect(result[1].eventId).toBe("evt_2");
  });

  it("scopes results to projectId", async () => {
    const t = convexTest(schema);
    const correlationId = "corr_shared";

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_a", correlationId, projectId: "proj_1",
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_b", correlationId, projectId: "proj_2",
    }));

    const result = await t.query(internal.events.listByCorrelationId, {
      projectId: "proj_1",
      correlationId,
    });

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe("evt_a");
  });
});

// ── listByType ──────────────────────────────────────────────────

describe("listByType", () => {
  it("filters by event type", async () => {
    const t = convexTest(schema);

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_cr", type: "CommandRequested" as const,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_cs", type: "CommandStarted" as const,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_cr2", type: "CommandRequested" as const,
    }));

    const result = await t.query(internal.events.listByType, {
      type: "CommandRequested",
    });

    expect(result).toHaveLength(2);
    expect(result.every((e: { type: string }) => e.type === "CommandRequested")).toBe(true);
  });

  it("respects time range bounds", async () => {
    const t = convexTest(schema);

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_early", type: "CardCreated" as const, ts: 1000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_mid", type: "CardCreated" as const, ts: 2000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_late", type: "CardCreated" as const, ts: 3000,
    }));

    const result = await t.query(internal.events.listByType, {
      type: "CardCreated",
      sinceTs: 1500,
      untilTs: 2500,
    });

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe("evt_mid");
  });

  it("respects limit", async () => {
    const t = convexTest(schema);

    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.events.appendEvent, makeEvent({
        eventId: `evt_${i}`, type: "ArtifactProduced" as const, ts: i * 1000,
      }));
    }

    const result = await t.query(internal.events.listByType, {
      type: "ArtifactProduced",
      limit: 3,
    });

    expect(result).toHaveLength(3);
  });
});

// ── listByTsRange (replay cursor) ──────────────────────────────

describe("listByTsRange", () => {
  it("returns events in ts order within a project", async () => {
    const t = convexTest(schema);

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_a", ts: 3000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_b", ts: 1000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_c", ts: 2000,
    }));

    const result = await t.query(internal.events.listByTsRange, {
      projectId: "proj_test",
      sinceTs: 0,
    });

    expect(result).toHaveLength(3);
    // Should be ordered by ts ascending (index ordering)
    expect(result[0].eventId).toBe("evt_b");
    expect(result[1].eventId).toBe("evt_c");
    expect(result[2].eventId).toBe("evt_a");
  });

  it("supports composite cursor with afterEventId", async () => {
    const t = convexTest(schema);

    // Events at the same timestamp — ULID ordering matters
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_aaa", ts: 1000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_bbb", ts: 1000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_ccc", ts: 2000,
    }));

    // Cursor: we've already seen evt_aaa at ts 1000
    const result = await t.query(internal.events.listByTsRange, {
      projectId: "proj_test",
      sinceTs: 1000,
      afterEventId: "evt_aaa",
    });

    // Should include evt_bbb (same ts, higher eventId) and evt_ccc (higher ts)
    expect(result.map((e: { eventId: string }) => e.eventId)).toContain("evt_bbb");
    expect(result.map((e: { eventId: string }) => e.eventId)).toContain("evt_ccc");
    expect(result.map((e: { eventId: string }) => e.eventId)).not.toContain("evt_aaa");
  });

  it("respects untilTs upper bound", async () => {
    const t = convexTest(schema);

    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_in", ts: 1000,
    }));
    await t.mutation(internal.events.appendEvent, makeEvent({
      eventId: "evt_out", ts: 3000,
    }));

    const result = await t.query(internal.events.listByTsRange, {
      projectId: "proj_test",
      sinceTs: 0,
      untilTs: 2000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe("evt_in");
  });

  it("respects limit", async () => {
    const t = convexTest(schema);

    for (let i = 0; i < 10; i++) {
      await t.mutation(internal.events.appendEvent, makeEvent({
        eventId: `evt_${String(i).padStart(3, "0")}`, ts: i * 100,
      }));
    }

    const result = await t.query(internal.events.listByTsRange, {
      projectId: "proj_test",
      sinceTs: 0,
      limit: 5,
    });

    expect(result).toHaveLength(5);
  });
});
