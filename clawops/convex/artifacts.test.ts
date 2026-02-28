import { describe, it, expect } from "vitest";
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
  userId: string = "user:alice",
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

const BASE_ARTIFACT = {
  projectId: PROJECT_A,
  content: "# Hello World\n\nThis is a test artifact.",
  encoding: "utf8" as const,
  type: "text/markdown",
  logicalName: "readme.md",
};

// ── 1. Upload + manifest creation ───────────────────────────────

describe("reportArtifact", () => {
  it("creates artifact manifest and emits ArtifactProduced", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const result = await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      commandId: "cmd_1",
      runId: "run_1",
    });

    expect(result.artifactId).toMatch(/^art_/);
    expect(result.deduplicated).toBe(false);

    // Verify manifest via getArtifact
    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId: result.artifactId,
    });

    expect(artifact).not.toBeNull();
    expect(artifact!.artifactId).toBe(result.artifactId);
    expect(artifact!.type).toBe("text/markdown");
    expect(artifact!.logicalName).toBe("readme.md");
    expect(artifact!.byteSize).toBeGreaterThan(0);
    expect(artifact!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact!.commandId).toBe("cmd_1");
    expect(artifact!.runId).toBe("run_1");
    expect(artifact!.eventId).toMatch(/^evt_/);
    expect(artifact!.storagePointer?.provider).toBe("convex-files");
    expect(artifact!.downloadUrl).toBeTruthy();

    // Verify ArtifactProduced event
    const events = await t.query(internal.events.listByType, {
      type: "ArtifactProduced",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifactId).toBe(result.artifactId);
    expect(events[0].payload.logicalName).toBe("readme.md");
    expect(events[0].payload.contentSha256).toBe(artifact!.contentSha256);
  });

  it("stores blob and returns download URL", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { artifactId } = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);

    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });

    expect(artifact!.downloadUrl).toBeTruthy();
    expect(typeof artifact!.downloadUrl).toBe("string");
  });

  it("accepts base64-encoded content", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const originalContent = "Binary test content 🎉";
    const base64Content = btoa(
      String.fromCharCode(...new TextEncoder().encode(originalContent)),
    );

    const result = await alice.action(api.artifacts.reportArtifact, {
      projectId: PROJECT_A,
      content: base64Content,
      encoding: "base64",
      type: "application/octet-stream",
      logicalName: "test.bin",
    });

    expect(result.artifactId).toMatch(/^art_/);
    expect(result.deduplicated).toBe(false);

    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId: result.artifactId,
    });

    expect(artifact!.byteSize).toBe(new TextEncoder().encode(originalContent).length);
  });

  it("stores labels in manifest", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const labels = { topic: "testing", audience: "internal" };
    const { artifactId } = await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      labels,
    });

    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });
    expect(artifact!.labels).toEqual(labels);
  });
});

// ── 2. Content dedup ────────────────────────────────────────────

describe("content dedup", () => {
  it("returns existing artifactId for same content in same project", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const first = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);
    expect(first.deduplicated).toBe(false);

    const second = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);
    expect(second.deduplicated).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);

    // Only one ArtifactProduced event
    const events = await t.query(internal.events.listByType, {
      type: "ArtifactProduced",
    });
    expect(events).toHaveLength(1);
  });

  it("creates separate artifacts for same content in different projects", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice", PROJECT_A);
    const bob = await setupProject(t, "user:bob", PROJECT_B);

    const alice = asUser(t, "user:alice");
    const resultA = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);

    const resultB = await bob.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      projectId: PROJECT_B,
    });

    expect(resultA.deduplicated).toBe(false);
    expect(resultB.deduplicated).toBe(false);
    expect(resultA.artifactId).not.toBe(resultB.artifactId);
  });

  it("creates separate artifacts for different content in same project", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const first = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);
    const second = await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      content: "Different content entirely",
      logicalName: "other.md",
    });

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(second.deduplicated).toBe(false);
  });
});

// ── 3. Provenance linking ───────────────────────────────────────

describe("provenance linking", () => {
  it("stores commandId and runId in manifest", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { artifactId } = await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      commandId: "cmd_provenance",
      runId: "run_provenance",
    });

    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });

    expect(artifact!.commandId).toBe("cmd_provenance");
    expect(artifact!.runId).toBe("run_provenance");
    expect(artifact!.eventId).toMatch(/^evt_/);
  });

  it("links eventId to the ArtifactProduced event", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const { artifactId } = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);

    const artifact = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });

    const events = await t.query(internal.events.listByType, {
      type: "ArtifactProduced",
    });

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(artifact!.eventId);
  });
});

// ── 4. getArtifact ──────────────────────────────────────────────

describe("getArtifact", () => {
  it("returns null for unknown artifactId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    const result = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId: "art_nonexistent",
    });
    expect(result).toBeNull();
  });

  it("returns null for cross-project artifact", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice", PROJECT_A);
    const bob = await setupProject(t, "user:bob", PROJECT_B);

    const { artifactId } = await bob.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      projectId: PROJECT_B,
    });

    // Alice queries project A for Bob's artifact
    const result = await alice.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });
    expect(result).toBeNull();
  });
});

// ── 5. artifactsForRun ──────────────────────────────────────────

describe("artifactsForRun", () => {
  it("returns artifacts filtered by runId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      runId: "run_1",
      logicalName: "a.md",
    });
    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      content: "second artifact",
      runId: "run_1",
      logicalName: "b.md",
    });
    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      content: "third artifact for different run",
      runId: "run_2",
      logicalName: "c.md",
    });

    const run1Artifacts = await alice.query(api.artifacts.artifactsForRun, {
      projectId: PROJECT_A,
      runId: "run_1",
    });
    expect(run1Artifacts).toHaveLength(2);

    const run2Artifacts = await alice.query(api.artifacts.artifactsForRun, {
      projectId: PROJECT_A,
      runId: "run_2",
    });
    expect(run2Artifacts).toHaveLength(1);
  });

  it("scopes to projectId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t, "user:alice", PROJECT_A);
    const bob = await setupProject(t, "user:bob", PROJECT_B);

    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      runId: "run_shared",
    });
    await bob.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      projectId: PROJECT_B,
      content: "bob's artifact",
      runId: "run_shared",
    });

    const aliceArtifacts = await alice.query(api.artifacts.artifactsForRun, {
      projectId: PROJECT_A,
      runId: "run_shared",
    });
    expect(aliceArtifacts).toHaveLength(1);
  });
});

// ── 6. artifactsForCommand ──────────────────────────────────────

describe("artifactsForCommand", () => {
  it("returns artifacts filtered by commandId", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);

    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      commandId: "cmd_1",
      logicalName: "a.md",
    });
    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      content: "second",
      commandId: "cmd_1",
      logicalName: "b.md",
    });
    await alice.action(api.artifacts.reportArtifact, {
      ...BASE_ARTIFACT,
      content: "third for different cmd",
      commandId: "cmd_2",
      logicalName: "c.md",
    });

    const cmd1 = await alice.query(api.artifacts.artifactsForCommand, {
      projectId: PROJECT_A,
      commandId: "cmd_1",
    });
    expect(cmd1).toHaveLength(2);

    const cmd2 = await alice.query(api.artifacts.artifactsForCommand, {
      projectId: PROJECT_A,
      commandId: "cmd_2",
    });
    expect(cmd2).toHaveLength(1);
  });
});

// ── 7. Cross-project isolation ──────────────────────────────────

describe("cross-project isolation", () => {
  it("user in project A cannot query project B artifacts", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice", PROJECT_A);
    await setupProject(t, "user:bob", PROJECT_B);

    const alice = asUser(t, "user:alice");

    await expect(
      alice.query(api.artifacts.artifactsForRun, {
        projectId: PROJECT_B,
        runId: "run_1",
      }),
    ).rejects.toThrow("Not a member of this project");
  });

  it("user in project A cannot report artifacts to project B", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t, "user:alice", PROJECT_A);
    await setupProject(t, "user:bob", PROJECT_B);

    const alice = asUser(t, "user:alice");

    await expect(
      alice.action(api.artifacts.reportArtifact, {
        ...BASE_ARTIFACT,
        projectId: PROJECT_B,
      }),
    ).rejects.toThrow("Not a member of this project");
  });
});

// ── 8. Auth ─────────────────────────────────────────────────────

describe("auth", () => {
  it("viewer cannot report artifacts", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t);
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const viewer = asUser(t, "user:viewer");
    await expect(
      viewer.action(api.artifacts.reportArtifact, BASE_ARTIFACT),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("bot can report artifacts", async () => {
    const t = convexTest(schema, modules);
    await setupProject(t);
    await addMember(t, "user:alice", "user:bot", "bot");

    const bot = asUser(t, "user:bot");
    const result = await bot.action(api.artifacts.reportArtifact, BASE_ARTIFACT);
    expect(result.artifactId).toMatch(/^art_/);
  });

  it("viewer can read artifacts", async () => {
    const t = convexTest(schema, modules);
    const alice = await setupProject(t);
    await addMember(t, "user:alice", "user:viewer", "viewer");

    const { artifactId } = await alice.action(api.artifacts.reportArtifact, BASE_ARTIFACT);

    const viewer = asUser(t, "user:viewer");
    const artifact = await viewer.query(api.artifacts.getArtifact, {
      projectId: PROJECT_A,
      artifactId,
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.artifactId).toBe(artifactId);
  });

  it("rejects unauthenticated access", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(api.artifacts.reportArtifact, BASE_ARTIFACT),
    ).rejects.toThrow("Unauthenticated");
  });
});
