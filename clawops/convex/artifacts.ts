import { v } from "convex/values";
import { action, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { artifactLink } from "./schema";
import { withAuthQ, ALL_ROLES } from "./auth";

// ── Helpers ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new TextEncoder().encode(content);
}

// ── Internal: resolve auth + check dedup ────────────────────────

export const _checkAuth = internalQuery({
  args: {
    projectId: v.string(),
    userId: v.string(),
    contentSha256: v.string(),
  },
  handler: async (ctx, args) => {
    // Check project membership
    const member = await ctx.db
      .query("project_members")
      .withIndex("by_userId_projectId", (q) =>
        q.eq("userId", args.userId).eq("projectId", args.projectId),
      )
      .unique();

    if (!member) {
      return { authorized: false as const, error: "Not a member of this project" };
    }

    // Role check: bot or owner
    if (member.role !== "owner" && member.role !== "bot") {
      return { authorized: false as const, error: "Insufficient permissions: requires bot or owner" };
    }

    // Check dedup
    // TODO: consider by_projectId_sha256 composite index if this becomes hot
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_sha256", (q) => q.eq("contentSha256", args.contentSha256))
      .collect();

    const duplicate = existing.find((a) => a.projectId === args.projectId);

    return {
      authorized: true as const,
      tenantId: member.tenantId,
      duplicate: duplicate ? { artifactId: duplicate.artifactId } : null,
    };
  },
});

// ── Internal: create manifest + emit event ──────────────────────

export const _createManifest = internalMutation({
  args: {
    artifactId: v.string(),
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    contentSha256: v.string(),
    type: v.string(),
    logicalName: v.string(),
    byteSize: v.number(),
    labels: v.optional(v.any()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    links: v.optional(v.array(artifactLink)),
    storageId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    await ctx.db.insert("artifacts", {
      artifactId: args.artifactId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      contentSha256: args.contentSha256,
      type: args.type,
      logicalName: args.logicalName,
      byteSize: args.byteSize,
      labels: args.labels,
      createdAt: now,
      commandId: args.commandId,
      runId: args.runId,
      eventId: args.eventId,
      storagePointer: {
        provider: "convex-files",
        key: args.storageId,
      },
      links: args.links,
    });

    await ctx.runMutation(internal.events.appendEvent, {
      eventId: args.eventId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      type: "ArtifactProduced",
      version: 1,
      ts: now,
      correlationId: args.correlationId ?? args.artifactId,
      commandId: args.commandId,
      runId: args.runId,
      producer: { service: "clawops-artifacts", version: "0.1.0" },
      payload: {
        artifactId: args.artifactId,
        contentSha256: args.contentSha256,
        byteSize: args.byteSize,
        type: args.type,
        logicalName: args.logicalName,
      },
    });

    return { artifactId: args.artifactId };
  },
});

// ── reportArtifact action (bot/owner) ───────────────────────────

export const reportArtifact = action({
  args: {
    projectId: v.string(),
    content: v.string(),
    encoding: v.union(v.literal("utf8"), v.literal("base64")),
    type: v.string(),
    logicalName: v.string(),
    labels: v.optional(v.any()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    links: v.optional(v.array(artifactLink)),
  },
  handler: async (ctx, args): Promise<{ artifactId: string; deduplicated: boolean }> => {
    // 1. Auth
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = identity.subject ?? identity.tokenIdentifier!;

    // 2. Decode + hash
    const bytes = decodeContent(args.content, args.encoding);
    const contentSha256 = await sha256Hex(bytes);

    // 3. Auth + dedup check
    const check = await ctx.runQuery(internal.artifacts._checkAuth, {
      projectId: args.projectId,
      userId,
      contentSha256,
    });

    if (!check.authorized) {
      throw new Error(check.error);
    }

    if (check.duplicate) {
      return { artifactId: check.duplicate.artifactId, deduplicated: true };
    }

    // 4. Upload blob
    const blob = new Blob([bytes as unknown as BlobPart], { type: args.type });
    const storageId = await ctx.storage.store(blob);

    // 5. Create manifest + emit event
    const artifactId = generateId("art");
    const eventId = generateId("evt");

    await ctx.runMutation(internal.artifacts._createManifest, {
      artifactId,
      eventId,
      tenantId: check.tenantId,
      projectId: args.projectId,
      contentSha256,
      type: args.type,
      logicalName: args.logicalName,
      byteSize: bytes.length,
      labels: args.labels,
      commandId: args.commandId,
      runId: args.runId,
      correlationId: args.correlationId,
      links: args.links,
      storageId,
    });

    return { artifactId, deduplicated: false };
  },
});

// ── getArtifact query (any role) ────────────────────────────────

export const getArtifact = query({
  args: {
    projectId: v.string(),
    artifactId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, auth) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", args.artifactId))
      .unique();

    if (!artifact) return null;
    if (artifact.projectId !== auth.projectId) return null;

    // Get signed download URL
    let downloadUrl: string | null = null;
    if (artifact.storagePointer?.provider === "convex-files") {
      downloadUrl = await ctx.storage.getUrl(artifact.storagePointer.key);
    }

    return { ...artifact, downloadUrl };
  }),
});

// ── artifactsForRun query (any role) ────────────────────────────

export const artifactsForRun = query({
  args: {
    projectId: v.string(),
    runId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, auth) => {
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();

    return artifacts.filter((a) => a.projectId === auth.projectId);
  }),
});

// ── artifactsForCommand query (any role) ────────────────────────

export const artifactsForCommand = query({
  args: {
    projectId: v.string(),
    commandId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, _auth) => {
    return await ctx.db
      .query("artifacts")
      .withIndex("by_projectId_commandId", (q) =>
        q.eq("projectId", args.projectId).eq("commandId", args.commandId),
      )
      .collect();
  }),
});

// ── _httpDedupCheck (HTTP adapter) ───────────────────────────

export const _httpDedupCheck = internalQuery({
  args: {
    projectId: v.string(),
    contentSha256: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_sha256", (q) => q.eq("contentSha256", args.contentSha256))
      .collect();
    const duplicate = existing.find((a) => a.projectId === args.projectId);
    return duplicate ? { artifactId: duplicate.artifactId } : null;
  },
});

// ── _httpReportArtifact (HTTP adapter, no RBAC) ──────────────

export const _httpReportArtifact = internalAction({
  args: {
    tenantId: v.string(),
    projectId: v.string(),
    content: v.string(),
    encoding: v.union(v.literal("utf8"), v.literal("base64")),
    type: v.string(),
    logicalName: v.string(),
    labels: v.optional(v.any()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    links: v.optional(v.array(artifactLink)),
  },
  handler: async (ctx, args): Promise<{ artifactId: string; deduplicated: boolean }> => {
    const bytes = decodeContent(args.content, args.encoding);
    const contentSha256 = await sha256Hex(bytes);

    const existing = await ctx.runQuery(internal.artifacts._httpDedupCheck, {
      projectId: args.projectId,
      contentSha256,
    });

    if (existing) {
      return { artifactId: existing.artifactId, deduplicated: true };
    }

    const blob = new Blob([bytes as unknown as BlobPart], { type: args.type });
    const storageId = await ctx.storage.store(blob);

    const artifactId = generateId("art");
    const eventId = generateId("evt");

    await ctx.runMutation(internal.artifacts._createManifest, {
      artifactId,
      eventId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      contentSha256,
      type: args.type,
      logicalName: args.logicalName,
      byteSize: bytes.length,
      labels: args.labels,
      commandId: args.commandId,
      runId: args.runId,
      correlationId: args.correlationId,
      links: args.links,
      storageId,
    });

    return { artifactId, deduplicated: false };
  },
});
