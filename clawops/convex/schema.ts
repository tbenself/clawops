import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// ── Enum Validators ─────────────────────────────────────────────

export const cardState = v.union(
  v.literal("READY"),
  v.literal("RUNNING"),
  v.literal("NEEDS_DECISION"),
  v.literal("RETRY_SCHEDULED"),
  v.literal("DONE"),
  v.literal("FAILED"),
);

export const decisionState = v.union(
  v.literal("PENDING"),
  v.literal("CLAIMED"),
  v.literal("RENDERED"),
  v.literal("EXPIRED"),
);

export const urgencyLevel = v.union(
  v.literal("now"),
  v.literal("today"),
  v.literal("whenever"),
);

export const commandStatus = v.union(
  v.literal("PENDING"),
  v.literal("RUNNING"),
  v.literal("SUCCEEDED"),
  v.literal("FAILED"),
  v.literal("CANCELED"),
);

export const runStatus = v.union(
  v.literal("RUNNING"),
  v.literal("SUCCEEDED"),
  v.literal("FAILED"),
);

export const rbacRole = v.union(
  v.literal("owner"),
  v.literal("operator"),
  v.literal("viewer"),
  v.literal("bot"),
);

export const eventType = v.union(
  // Command lifecycle
  v.literal("CommandRequested"),
  v.literal("CommandStarted"),
  v.literal("CommandSucceeded"),
  v.literal("CommandFailed"),
  v.literal("CommandCanceled"),
  v.literal("CommandRetryScheduled"),
  v.literal("CommandSkippedDuplicate"),
  // Decision lifecycle
  v.literal("DecisionRequested"),
  v.literal("DecisionClaimed"),
  v.literal("DecisionRendered"),
  v.literal("DecisionRenderRejected"),
  v.literal("DecisionExpired"),
  // Artifact + Card lifecycle
  v.literal("ArtifactProduced"),
  v.literal("CardCreated"),
  v.literal("CardTransitioned"),
  // Operational
  v.literal("SloBreached"),
  v.literal("DecisionDeferred"),
  v.literal("DecisionClaimExpired"),
  v.literal("ReconciliationDrift"),
);

// ── Reusable Object Validators ──────────────────────────────────

export const producer = v.object({
  service: v.string(),
  version: v.string(),
});

export const decisionOption = v.object({
  key: v.string(),
  label: v.string(),
  consequence: v.string(),
});

export const sourceThread = v.object({
  platform: v.string(),
  channelId: v.string(),
  messageId: v.string(),
});

export const commandConstraints = v.object({
  priority: v.optional(v.number()),
  timeoutMs: v.optional(v.number()),
  maxRetries: v.optional(v.number()),
  concurrencyKey: v.optional(v.string()),
});

export const commandSpec = v.object({
  commandType: v.string(),
  commandVersion: v.optional(v.number()),
  args: v.optional(v.any()),
  context: v.optional(v.any()),
  constraints: v.optional(commandConstraints),
});

export const cardSpec = v.object({
  commandType: v.string(),
  args: v.optional(v.any()),
  constraints: v.optional(
    v.object({
      concurrencyKey: v.optional(v.string()),
      maxRetries: v.optional(v.number()),
    }),
  ),
});

export const storagePointer = v.object({
  provider: v.union(
    v.literal("convex-files"),
    v.literal("s3"),
    v.literal("r2"),
  ),
  bucket: v.optional(v.string()),
  key: v.string(),
});

export const artifactLink = v.object({
  rel: v.string(),
  artifactId: v.string(),
});

// ── Schema ──────────────────────────────────────────────────────

export default defineSchema({
  ...authTables,

  // Event Bus — append-only log (§4, §11.1)
  events: defineTable({
    eventId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    type: eventType,
    version: v.number(),
    ts: v.number(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    cardId: v.optional(v.string()),
    decisionId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    producer: producer,
    tags: v.optional(v.any()),
    payload: v.any(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_projectId_correlationId_ts", [
      "projectId",
      "correlationId",
      "ts",
    ])
    .index("by_type_ts", ["type", "ts"])
    .index("by_projectId_ts", ["projectId", "ts"]),

  // Commands — read model, latest state per command (§5, §11.2)
  commands: defineTable({
    commandId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    status: commandStatus,
    latestRunId: v.optional(v.string()),
    lastEventId: v.optional(v.string()),
    updatedTs: v.number(),
    priority: v.number(),
    commandSpec: commandSpec,
  })
    .index("by_commandId", ["commandId"])
    .index("by_projectId_status_priority", [
      "projectId",
      "status",
      "priority",
    ])
    .index("by_projectId_updatedTs", ["projectId", "updatedTs"]),

  // Runs — read model, attempt state (§11.2)
  runs: defineTable({
    runId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    commandId: v.string(),
    status: runStatus,
    startedTs: v.optional(v.number()),
    endedTs: v.optional(v.number()),
    attempt: v.number(),
    executor: v.optional(v.string()),
    error: v.optional(v.any()),
  })
    .index("by_runId", ["runId"])
    .index("by_commandId_startedTs", ["commandId", "startedTs"])
    .index("by_projectId_status_startedTs", [
      "projectId",
      "status",
      "startedTs",
    ]),

  // Cards — work items + state machine (§9, §11.2)
  cards: defineTable({
    cardId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    state: cardState,
    priority: v.number(),
    title: v.string(),
    spec: cardSpec,
    createdTs: v.number(),
    updatedTs: v.number(),
    attempt: v.number(),
    retryAtTs: v.optional(v.number()),
    capabilities: v.optional(v.array(v.string())),
    // v2-reserved lease fields (§10.6) — null in v1, included to avoid migration
    leasedTo: v.optional(v.string()),
    leaseUntilTs: v.optional(v.number()),
    lastHeartbeatTs: v.optional(v.number()),
  })
    .index("by_cardId", ["cardId"])
    .index("by_projectId_state_priority", [
      "projectId",
      "state",
      "priority",
    ])
    .index("by_projectId_updatedTs", ["projectId", "updatedTs"]),

  // Decisions — the decision queue (§6, §11.2)
  decisions: defineTable({
    decisionId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    cardId: v.string(),
    commandId: v.string(),
    runId: v.string(),
    state: decisionState,
    urgency: urgencyLevel,
    title: v.string(),
    contextSummary: v.optional(v.string()),
    options: v.array(decisionOption),
    artifactRefs: v.optional(v.array(v.string())),
    sourceThread: v.optional(sourceThread),
    requestedAt: v.number(),
    expiresAt: v.optional(v.number()),
    fallbackOption: v.optional(v.string()),
    // Claiming fields (§6.6)
    claimedBy: v.optional(v.string()),
    claimedUntil: v.optional(v.number()),
    // Render fields (§6.5)
    renderedOption: v.optional(v.string()),
    renderedAt: v.optional(v.number()),
    renderedBy: v.optional(v.string()),
  })
    .index("by_decisionId", ["decisionId"])
    .index("by_projectId_state_urgency", ["projectId", "state", "urgency"])
    .index("by_projectId_renderedAt", ["projectId", "renderedAt"])
    .index("by_claimedBy_state", ["claimedBy", "state"]),

  // Artifacts — registry / manifests (§7, §11.2)
  artifacts: defineTable({
    artifactId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    contentSha256: v.string(),
    type: v.string(),
    logicalName: v.string(),
    byteSize: v.number(),
    labels: v.optional(v.any()),
    createdAt: v.number(),
    // Provenance (§7.2) — flattened for indexing
    commandId: v.optional(v.string()),
    runId: v.optional(v.string()),
    eventId: v.optional(v.string()),
    // Storage pointer (§11.3)
    storagePointer: v.optional(storagePointer),
    // Artifact linking (§7.2)
    links: v.optional(v.array(artifactLink)),
  })
    .index("by_artifactId", ["artifactId"])
    .index("by_sha256", ["contentSha256"])
    .index("by_runId", ["runId"])
    .index("by_projectId_commandId", ["projectId", "commandId"])
    .index("by_projectId_logicalName_createdAt", [
      "projectId",
      "logicalName",
      "createdAt",
    ]),

  // Projects — project registry (§14.1)
  projects: defineTable({
    tenantId: v.string(),
    projectId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_projectId", ["projectId"])
    .index("by_tenantId", ["tenantId"]),

  // Project Members — RBAC (§14.1)
  project_members: defineTable({
    tenantId: v.string(),
    projectId: v.string(),
    userId: v.string(),
    role: rbacRole,
  })
    .index("by_userId_projectId", ["userId", "projectId"])
    .index("by_projectId_role", ["projectId", "role"]),

  // Event Archives — cold storage index (§14.4)
  event_archives: defineTable({
    archiveId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    fromTs: v.number(),
    toTs: v.number(),
    eventCount: v.number(),
    storagePointer: v.string(),
    archivedAt: v.number(),
  }).index("by_projectId_fromTs", ["projectId", "fromTs"]),
});

// ── Exported Types ──────────────────────────────────────────────

export type CardState = Infer<typeof cardState>;
export type DecisionState = Infer<typeof decisionState>;
export type UrgencyLevel = Infer<typeof urgencyLevel>;
export type CommandStatus = Infer<typeof commandStatus>;
export type RunStatus = Infer<typeof runStatus>;
export type RbacRole = Infer<typeof rbacRole>;
export type EventType = Infer<typeof eventType>;
export type Producer = Infer<typeof producer>;
export type DecisionOption = Infer<typeof decisionOption>;
export type SourceThread = Infer<typeof sourceThread>;
export type CommandConstraints = Infer<typeof commandConstraints>;
export type CommandSpec = Infer<typeof commandSpec>;
export type CardSpec = Infer<typeof cardSpec>;
export type StoragePointer = Infer<typeof storagePointer>;
export type ArtifactLink = Infer<typeof artifactLink>;
