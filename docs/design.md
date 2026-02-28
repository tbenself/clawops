# ClawOps: A Decision Queue for Humans in AI Agent Workflows

## 0) Summary

ClawOps is a Convex-native ops runtime that solves a specific problem: **you are the slowest link in your AI agent system.** Bots block on human decisions across scattered threads and platforms, context gets lost, and work stalls silently. ClawOps provides a unified **Decision Queue** — a single, prioritized inbox where every bot-blocked-on-human decision surfaces with full context, artifacts, and one-click resolution. Under the hood, an append-only **Event Bus** provides end-to-end traceability, an immutable **Artifact Store** ensures you can see what any bot produced and why, and a **Convex Workflow + Workpool** executor keeps automated work moving reliably. The system is designed to be shipped as a reusable skill for anyone running AI agents.

---

## 1) Goals / Non-goals

### Goals

- **Unified decision inbox**: Every bot-needs-human moment surfaces in one place with full context, regardless of originating platform.
- **End-to-end traceability**: Every command, run, decision, and artifact is linked via IDs and causal chains. "What happened, why, and what did it produce?" is always answerable.
- **Deterministic execution**: Idempotency keys, retries, and state machine rules prevent double work and lost work.
- **Artifacts as first-class outputs**: Immutable, content-addressed, typed, and linked to the bus — so when a bot asks you to approve something, you can see the thing.
- **Convex-native**: Leverage Convex's transactional mutations, realtime subscriptions, and scheduled functions as the coordination layer. No bolted-on Redis or polling loops.
- **Skill-packaged for reuse**: Clear install story, minimal adapter interface, documented tables and functions.

### Non-goals (v1)

- Distributed consensus / multi-datacenter exactly-once.
- Arbitrary workflow DSL. (Start with commands + decision points; add workflow graphs later.)
- Full-featured UI. (Design supports a UI, but v1 is a functional web dashboard powered by Convex queries and subscriptions.)
- General-purpose message bus replacement (Kafka/NATS). This is domain-specific.
- REST API. (v1 consumers are Convex functions and subscriptions. A thin HTTP adapter for non-Convex bots is a v1.5 stretch goal; see Section 16.)

---

## 2) Key Concepts

### Entities

- **Command**: A user- or system-requested operation (e.g., "sync meeting notes", "compile digest", "run healthcheck").
- **Run**: A concrete execution attempt of a command (may retry).
- **Artifact**: Immutable output produced by a run (file, JSON, markdown, image, log bundle, etc.).
- **Card**: A work item that maps to a command; has a state machine centered on decision flow.
- **Decision Request**: A structured request for human input, created when a bot blocks on a choice. The primary user-facing object.
- **Bus Event**: An append-only record describing something that happened.

### Identity + Causality

Every object is tied together via:

- `event_id` — unique per event (ULID)
- `command_id` — stable for the logical command
- `run_id` — unique per execution attempt
- `card_id` — work item identity
- `decision_id` — unique per human decision point
- `correlation_id` — ties a full chain across systems (e.g., one card's entire lifecycle)
- `causation_id` — the immediate parent event that caused this event

This is the core of "why did this happen" and "what did it produce."

---

## 3) Architecture Overview

### Components

1. **Bus (Event Log)** — Append-only event storage. Publish/subscribe. Query by ID, time window, type, correlation.

2. **Artifact Store** — Content-addressed blob storage + metadata manifests. Strong linking to bus events and runs.

3. **Decision Queue** — The primary user-facing feature. Pending decisions with context, artifacts, options, urgency, and expiration. Powered by Convex subscriptions for realtime updates.

4. **Executor** — Built on Convex Workflow + Workpool. Manages command lifecycle with durable execution and concurrency control. Emits all lifecycle events. Creates decision requests when human input is needed. ClawOps wraps Convex primitives to add event sourcing, decision pause/resume, and artifact provenance.

5. **Notification Digest** — Consolidates all pending decisions into batched notifications sent to a single channel.

### Data Flow (decision path — the interesting one)

```
1. CommandRequested           → "sync and publish weekly digest"
2. CommandStarted (run 1)     → executor claims work
3. ArtifactProduced           → digest.md created
4. DecisionRequested          → "3 flagged articles — approve, edit, or skip?"
   ├── Card transitions to NEEDS_DECISION
   ├── Decision appears in queue UI
   └── Notification digest fires (batched)
5. DecisionRendered           → user chooses "approve" from queue
   └── Card transitions back to RUNNING
6. CommandSucceeded           → digest published
7. CardTransitioned → DONE
```

### Data Flow (automated happy path)

```
1. CommandRequested
2. CommandStarted (run 1)
3. ArtifactProduced (0..N)
4. CommandSucceeded
5. CardTransitioned → DONE
```

---

## 4) Bus Design

### 4.1 Event Envelope (required fields)

All event types share a common envelope:

```json
{
  "schema": "clawops.bus.event.v1",
  "event_id": "evt_01J...ULID",
  "event_type": "DecisionRequested",
  "event_version": 1,
  "timestamp": "2026-02-28T16:10:00.123Z",
  "scope": {
    "tenant_id": "tenant_01J...",
    "project_id": "proj_01J..."
  },
  "producer": {
    "service": "kanban-executor",
    "version": "0.1.0"
  },
  "correlation_id": "corr_01J...ULID",
  "causation_id": "evt_01J...PARENT",
  "subject": {
    "command_id": "cmd_01J...ULID",
    "run_id": "run_01J...ULID",
    "card_id": "card_01J...ULID",
    "decision_id": "dec_01J...ULID"
  },
  "idempotency_key": "stable-string-or-hash",
  "tags": {
    "env": "prod",
    "team": "digest-bot",
    "priority": "P2"
  },
  "payload": {}
}
```

**Rules**

- `event_id`: ULID (sortable, unique).
- `timestamp`: ISO-8601 UTC.
- `scope.tenant_id`: required. Identifies the tenant (Convex deployment) that owns this event. All queries are implicitly scoped to the caller's tenant.
- `scope.project_id`: required. Identifies the project within a tenant. A project groups related bots, commands, and decisions (e.g., "content-pipeline", "home-automation"). Enables multi-project dashboards and per-project RBAC.
- `event_type` + `event_version`: allow schema evolution. Breaking change → bump version; support dual read. Prefer additive payload changes.
- `correlation_id`: stable across the whole chain (e.g., one card's full lifecycle).
- `causation_id`: parent event that triggered this one (null for root events).
- `subject.*`: include whichever IDs are relevant; `command_id` is always present for command lifecycle events; `decision_id` is present for decision lifecycle events.
- `idempotency_key`: required for `CommandRequested`, recommended elsewhere.

### 4.2 Event Types (v1)

**Command lifecycle:**

1. **CommandRequested** — "A logical command should run." Emitted by: UI/CLI, scheduler, executor. Includes: command spec, priority, idempotency key.

2. **CommandStarted** — "An executor claimed this command and began an attempt." Includes: `run_id`, executor identity.

3. **CommandSucceeded** — "Run completed successfully." Includes: summary, optional metrics, artifact refs.

4. **CommandFailed** — "Run failed (terminal for this run)." Includes: structured error, retryability hint, backoff suggestion.

5. **CommandCanceled** — "Operator or system preempted this command."

6. **CommandRetryScheduled** — "A retry has been scheduled." Includes: next attempt time, attempt number, backoff duration.

7. **CommandSkippedDuplicate** — "A duplicate CommandRequested was received and skipped because a successful run already exists for this idempotency key." Includes: original `command_id`, existing run result reference.

**Decision lifecycle:**

8. **DecisionRequested** — "A bot needs human input to proceed." Includes: decision spec (title, options, context, urgency, artifact refs, expiration).

9. **DecisionClaimed** — "An operator claimed a decision for review." Includes: who claimed, claim expiration. (Advisory; see §6.6.)

10. **DecisionRendered** — "A human made a choice." Includes: selected option, who decided, optional note.

11. **DecisionRenderRejected** — "A render attempt was rejected because the decision was already rendered or expired (stale write)." Includes: attempted option, who attempted, current decision state.

12. **DecisionExpired** — "Nobody responded in time." Includes: fallback action taken (if any).

**Artifact + Card lifecycle:**

13. **ArtifactProduced** — "A run produced an artifact that is now stored." Includes: artifact manifest pointer (content hash), type, size, logical name.

14. **CardCreated** — "A new work item entered the system."

15. **CardTransitioned** — "A card changed state." Includes: `from`, `to`, `reason`.

**Operational lifecycle:**

16. **SloBreached** — "A decision SLO target was exceeded." Includes: urgency level, metric (p50/p95/backlog), target, actual value. (Informational; drives escalation and load shedding. See §13.4.)

17. **DecisionDeferred** — "A decision was deferred by load shedding." Includes: `decision_id`, reason, original urgency, deferred action taken. (See §12.4.)

18. **DecisionClaimExpired** — "An operator's claim on a decision expired without rendering." Includes: `decision_id`, `claimedBy`, original claim time. Decision returns to unclaimed pool. (See §6.6.)

19. **ReconciliationDrift** — "Event counts and read model row counts diverged." Includes: affected table, expected count, actual count, drift magnitude. (Informational; triggers investigation. See §19.5.)

### 4.3 Canonical Event Sequences (contracts)

The following sequences are the only valid orderings for event chains. These should be enforced by contract tests that verify: (a) no event type appears out of sequence, (b) required causation links are present, and (c) terminal events are never followed by non-terminal events for the same subject.

**Automated command (happy path):**
`CommandRequested` → `CardCreated` → `CardTransitioned(READY→RUNNING)` + `CommandStarted` → `ArtifactProduced`* → `CommandSucceeded` → `CardTransitioned(RUNNING→DONE)`

**Decision path:**
`...CommandStarted` → `ArtifactProduced`* → `DecisionRequested` → `CardTransitioned(RUNNING→NEEDS_DECISION)` → `DecisionClaimed`? → `DecisionRendered` → `CardTransitioned(NEEDS_DECISION→RUNNING)` → `CommandSucceeded` → `CardTransitioned(RUNNING→DONE)`

**Retry path:**
`...CommandStarted` → `CommandFailed` → `CommandRetryScheduled` → `CardTransitioned(RUNNING→RETRY_SCHEDULED)` → `CardTransitioned(RETRY_SCHEDULED→READY)` → *(re-enter from claim)*

**Duplicate skip:**
`CommandRequested` → `CommandSkippedDuplicate`

**Decision expiration:**
`DecisionRequested` → `DecisionExpired` → `CardTransitioned(NEEDS_DECISION→RUNNING)` *(if fallback)* | `CardTransitioned(NEEDS_DECISION→FAILED)` *(if no fallback)*

`ArtifactProduced`* = zero or more artifact events.

---

## 5) Command Model

### 5.1 Command Spec

A command is a typed request. Keep it stable and hashable.

```json
{
  "command_type": "notes.sync",
  "command_version": 1,
  "scope": {
    "tenant_id": "tenant_01J...",
    "project_id": "proj_01J..."
  },
  "args": {
    "source": "exports",
    "since": "2026-02-27T00:00:00Z"
  },
  "context": {
    "requested_by": "user:alice",
    "channel": "slack",
    "note": "daily sync"
  },
  "constraints": {
    "priority": 50,
    "timeout_ms": 600000,
    "max_retries": 3,
    "concurrency_key": "notes-sync"
  }
}
```

### 5.2 Idempotency

Define idempotency at the `CommandRequested` level:

- `idempotency_key = hash(command_type + normalized_args + logical_window)`
- If a duplicate request arrives with the same key and a successful run already exists, the executor emits `CommandSkippedDuplicate` and returns the existing result.

---

## 6) Decision Request Model

This is the primary user-facing data structure. When a bot blocks on human input, it creates a decision request.

### 6.1 Decision Request Spec

```json
{
  "schema": "clawops.decision.request.v1",
  "decision_id": "dec_01J...",
  "scope": {
    "tenant_id": "tenant_01J...",
    "project_id": "proj_01J..."
  },
  "card_id": "card_01J...",
  "command_id": "cmd_01J...",
  "run_id": "run_01J...",
  "requested_at": "2026-02-28T16:10:00Z",
  "urgency": "today",
  "title": "Approve weekly digest for publishing",
  "context_summary": "DigestBot compiled 12 articles into a digest. 3 flagged as potentially outdated.",
  "options": [
    {
      "key": "approve",
      "label": "Publish as-is",
      "consequence": "Posts to blog and sends newsletter"
    },
    {
      "key": "edit",
      "label": "Let me edit first",
      "consequence": "Opens artifact for editing, blocks publish"
    },
    {
      "key": "reject",
      "label": "Skip this week",
      "consequence": "Archives digest, no publish"
    }
  ],
  "artifact_refs": ["art_01J...digest", "art_01J...flagged_items"],
  "source_thread": {
    "platform": "slack",
    "channel_id": "...",
    "message_id": "..."
  },
  "expires_at": "2026-03-01T09:00:00Z",
  "fallback_option": "reject"
}
```

### 6.2 Decision Context Bundle

The decision queue is only useful if each decision carries enough context that you don't have to go find the original thread. When rendering a decision, the system assembles:

- **Artifacts produced so far** — linked via `artifact_refs`. The digest draft, the analysis, the screenshot — whatever the bot made.
- **Event chain summary** — auto-generated from the `correlation_id` trail. "DigestBot started notes sync → pulled 12 articles → compiled digest → flagged 3 as outdated → asking you."
- **Original command spec** — what was this bot trying to do, with what args, requested by whom.
- **Source thread link** — so you *can* go back to the originating platform if you want, but shouldn't have to.

This is assembled at read time (Convex query), not stored redundantly.

### 6.3 Urgency Levels

- `now` — bot is actively blocked and waiting; decision needed in minutes.
- `today` — should be resolved today; bot can continue other work meanwhile.
- `whenever` — no rush; informational or low-priority approval.

### 6.4 Expiration + Fallback

- `expires_at`: optional timestamp. If set, the sweeper emits `DecisionExpired` when the deadline passes.
- `fallback_option`: optional. If set, the expired decision auto-resolves with this option key. If not set, the card transitions to `FAILED` with reason "decision_expired".

### 6.5 Render Concurrency (compare-and-set)

Multiple actors can attempt to render the same decision simultaneously: two humans in the UI, a human racing against the expiration sweeper, or a retry that creates a duplicate render call. The `renderDecision` mutation must enforce atomic compare-and-set semantics:

1. Resolve `renderedBy` from `ctx.auth.getUserIdentity()`. Reject if unauthenticated.
2. Read the decision's current `state`.
3. If `state != PENDING` and `state != CLAIMED`, reject the render: emit `DecisionRenderRejected` with the attempted option, the actor, and the current state. Return an error to the caller (not a silent no-op — the actor should know they lost the race).
4. If `state == CLAIMED`, validate that `claimedBy` matches the caller. If not, reject.
5. If valid, atomically set `state = RENDERED`, `renderedOption`, `renderedBy`, `renderedAt` in a single Convex mutation.

Because Convex mutations are serialized per-document, this is naturally atomic — no external locking needed. The key contract is: **exactly one `DecisionRendered` event is ever emitted per `decision_id`.** All other attempts produce `DecisionRenderRejected`.

The UI should handle rejection gracefully: show "This decision was already resolved" rather than an error state, and refresh the decision queue.

### 6.6 Decision Claiming (multi-operator)

When multiple operators share a decision queue, two people reviewing the same decision simultaneously is wasteful. Decision claiming prevents this with a lightweight lease:

**Fields on the `decisions` read model:**
- `claimedBy`: user ID of the operator who claimed it, or null.
- `claimedUntil`: timestamp when the claim expires, or null.

**Mutation: `claimDecision({ decisionId })`**

The caller's identity is derived from the Convex auth context (`ctx.auth.getUserIdentity()`), never accepted as an input parameter. Accepting caller identity from input would allow any client to claim decisions as any user, bypassing RBAC entirely.

1. Resolve `userId` from `ctx.auth`. Reject if unauthenticated.
2. Validate caller has `operator` or `owner` role in the decision's project (via RBAC middleware §14.1).
3. If `state != PENDING`, reject (already resolved).
4. If `claimedBy != null` and `claimedUntil > now` and `claimedBy != userId`, reject: another operator is reviewing it. Return `{ status: "already_claimed", claimedBy, claimedUntil }` so the UI can show who has it.
5. Otherwise, set `claimedBy = userId`, `claimedUntil = now + DECISION_CLAIM_MS` (default: 5 minutes).
6. Emit `DecisionClaimed` event.

**Mutation: `renewDecisionClaim({ decisionId })`**

Extends an active claim while the operator is still reviewing. Identity derived from `ctx.auth`.

1. Resolve `userId` from `ctx.auth`. Reject if unauthenticated.
2. If `state != CLAIMED` or `claimedBy != userId`, reject (claim was lost or expired).
3. Set `claimedUntil = now + DECISION_CLAIM_MS`.
4. No event emitted (renewals are high-frequency and low-signal; the original `DecisionClaimed` event is sufficient for audit).

**Claim expiration:** if an operator claims a decision but walks away, the claim expires and the decision returns to the unclaimed pool. The sweeper (§10.3) handles this: find decisions where `state == CLAIMED` and `claimedUntil < now`, set `state = PENDING`, clear `claimedBy` and `claimedUntil`, and emit `DecisionClaimExpired`. The decision is immediately available for other operators to claim.

**UI behavior:**
- Decision queue shows a "claimed by [name]" badge on claimed decisions.
- Clicking a decision auto-claims it. If claim fails, show "Alice is already reviewing this."
- Claim auto-renews while the decision detail view is open (heartbeat every 2 minutes).
- Rendering a decision clears the claim as part of the same mutation.
- If an operator's claim expires while they're still viewing, the UI should detect this (via subscription) and prompt: "Your claim expired — reclaim to continue reviewing."

**Note:** claiming is advisory, not a hard gate. An operator can still render an unclaimed decision directly (the CAS in §6.5 is the actual safety net). Claiming is a UX optimization to reduce wasted effort.

---

## 7) Artifact Design

### 7.1 Principles

- **Immutable**: artifacts never change; new version = new artifact.
- **Content-addressed**: identity is `sha256` hash of bytes.
- **Typed**: each artifact has a media type (`text/markdown`, `application/json`, `image/png`, `log/bundle`, etc.).
- **Manifest + blob**: metadata stored separately from the blob for fast indexing/querying.

### 7.2 Artifact Manifest (v1)

```json
{
  "schema": "clawops.artifact.manifest.v1",
  "artifact_id": "art_01J...ULID",
  "scope": {
    "tenant_id": "tenant_01J...",
    "project_id": "proj_01J..."
  },
  "content_sha256": "hex...",
  "byte_size": 12345,
  "created_at": "2026-02-28T16:10:03.456Z",
  "type": "text/markdown",
  "logical_name": "digest.md",
  "labels": {
    "topic": "weekend-reading",
    "audience": "internal"
  },
  "provenance": {
    "command_id": "cmd_...",
    "run_id": "run_...",
    "event_id": "evt_..._ArtifactProduced"
  },
  "links": [
    { "rel": "source", "artifact_id": "art_...optional" }
  ]
}
```

### 7.3 Persisted vs Transient

- **Persisted**: user-visible outputs, evidence for debugging, canonical inputs/outputs.
- **Transient**: large intermediate scratch, ephemeral logs not needed after success (artifacts with TTL).

### 7.4 Naming

- Stable `logical_name` is for humans (`digest.md`).
- True identity is `content_sha256` + `artifact_id`.
- "Latest" is computed via query: filter by `logical_name`, sort by `created_at` descending.

---

## 8) Linking Events ↔ Artifacts (Traceability)

Two strong links:

1. `ArtifactProduced.subject.run_id` ties the artifact to a specific execution attempt.
2. Manifest `provenance.event_id` ties the artifact to the bus event that announced it.

Combined with `correlation_id`, you can always walk from a decision request → the command that triggered it → the run that produced artifacts → the artifacts themselves.

---

## 9) Card Model + State Machine

### 9.1 Card Spec

```json
{
  "schema": "clawops.card.v1",
  "card_id": "card_01J...",
  "scope": {
    "tenant_id": "tenant_01J...",
    "project_id": "proj_01J..."
  },
  "title": "Notes → Knowledge base sync",
  "state": "READY",
  "priority": 50,
  "created_at": "2026-02-28T16:00:00Z",
  "updated_at": "2026-02-28T16:10:00Z",
  "attempt": 1,
  "retryAtTs": null,
  "capabilities": ["notes", "knowledge-base"],
  "spec": {
    "command_type": "notes.sync",
    "args": { "source": "exports" },
    "constraints": { "concurrency_key": "notes-sync", "max_retries": 3 }
  },
  "_v2_reserved": {
    "leasedTo": null,
    "leaseUntilTs": null,
    "lastHeartbeatTs": null
  }
}
```

> **Note:** `leasedTo`, `leaseUntilTs`, and `lastHeartbeatTs` are reserved for the v2 custom lease executor (§10.6). In v1 they are null; include them in the schema from the start to avoid migration later.

### 9.2 State Machine

States are centered on the decision flow:

```
READY → RUNNING → DONE                                     (fully automated)
READY → RUNNING → NEEDS_DECISION → RUNNING → DONE          (human in the loop)
READY → RUNNING → FAILED                                   (terminal failure)
READY → RUNNING → RETRY_SCHEDULED → READY                  (retry path)
READY → RUNNING → NEEDS_DECISION → FAILED                  (decision expired, no fallback)
```

**States:**

- `READY` — eligible for work claiming
- `RUNNING` — executor is actively processing this card (Convex Workflow in progress)
- `NEEDS_DECISION` — blocked on human input; linked `decision_id` is PENDING
- `RETRY_SCHEDULED` — failed but retryable; waiting for `retryAtTs`
- `DONE` — completed successfully
- `FAILED` — terminal failure (exhausted retries, or decision expired with no fallback)

All transitions emit `CardTransitioned` events with `from`, `to`, `reason`, and optional `decision_id`.

### 9.3 Queue Semantics

- **Priorities**: integer (lower = higher priority; 0 is most urgent).
- **Concurrency**: global limit + per `concurrency_key` limit (default 1).
- **Retries**: on retryable failure, schedule a new run with `retryAtTs = now + backoff`.
- **Idempotency**: skip duplicate `CommandRequested` with same `idempotency_key`.

---

## 10) Executor Design

### 10.1 Handler Interface

Executor calls handlers based on `command_type`. Handlers can produce artifacts and/or request decisions.

```ts
type HandlerResult = {
  artifacts?: ArtifactToWrite[];
  decision?: DecisionRequestParams;  // if set, card blocks on human input
  summary?: string;
  metrics?: Record<string, number>;
};

handle(command: CommandSpec, ctx: RunContext): Promise<HandlerResult>;
```

If the handler returns a `decision`, the executor:
1. Writes any produced artifacts
2. Emits `ArtifactProduced` events
3. Creates the decision request
4. Emits `DecisionRequested`
5. Transitions the card to `NEEDS_DECISION`

When the decision is rendered, the executor picks up the card and continues.

### 10.2 v1 Execution: Convex Workflow + Workpool

v1 delegates execution durability and concurrency to **Convex Workflow** and **Convex Workpool** rather than building custom lease/heartbeat infrastructure. This keeps v1 focused on the novel parts (decision flow, event sourcing, artifact provenance) and avoids reimplementing primitives Convex already provides.

**How it works:**

- **Workpool** manages concurrency: each command type maps to a Workpool pool with a configurable concurrency limit (default 1 per `concurrency_key`). When a card transitions to `READY`, a Workpool job is enqueued.
- **Workflow** manages durability: each job runs as a Convex Workflow that handles the full command lifecycle (start → handler → artifacts → decision-or-complete). Workflows survive process restarts and provide automatic retries with configurable backoff.
- **ClawOps wraps both** to add: event emission at each state transition, artifact provenance linking, decision request creation and resume-on-render, and the card state machine.

**What ClawOps adds on top of Convex primitives:**

| Concern | Convex primitive | ClawOps layer |
|---|---|---|
| Job queuing + concurrency | Workpool | Card state machine + priority ordering |
| Durability + retries | Workflow | Event emission at each step |
| Human decision pause/resume | *(not supported)* | `NEEDS_DECISION` state + `DecisionRequested`/`DecisionRendered` |
| Artifact provenance | *(not supported)* | Manifest linking to run_id + event_id |
| Observability | Workflow dashboard | Append-only event bus + correlation chains |

**Decision pause pattern in Workflow:**

When a handler needs human input, the Workflow:
1. Emits `DecisionRequested` + writes decision to `decisions` table.
2. Transitions card to `NEEDS_DECISION`.
3. Sleeps on a signal (Convex Workflow supports sleeping until an external signal wakes it).
4. When `renderDecision` is called, it signals the sleeping Workflow with the outcome.
5. Workflow resumes, continues handler execution.

If Convex Workflow does not support external signal wake-up natively, the fallback is: the Workflow polls the decision state on a short interval (e.g., 30s) via `ctx.sleep()` + check. This is less elegant but functional and still avoids custom lease infrastructure.

### 10.3 Scheduled Sweeper (Guaranteed Progress)

A scheduled Convex cron function runs every 1–5 minutes:

1. **Release retries**: find cards where `state == RETRY_SCHEDULED` and `retryAtTs <= now`. Transition to `READY` and enqueue a new Workpool job.

2. **Expire decisions**: find decisions where `state IN (PENDING, CLAIMED)` and `expires_at <= now`. Emit `DecisionExpired`. If `fallback_option` is set, auto-resolve and signal the sleeping Workflow. If not, transition card to `FAILED`. (A claimed decision can still expire — the claim doesn't extend the deadline.)

3. **Reclaim expired decision claims**: find decisions where `state == CLAIMED` and `claimedUntil < now`. Set `state = PENDING`, clear `claimedBy` and `claimedUntil`, emit `DecisionClaimExpired`. The decision returns to the unclaimed pool.

4. **Decision digest** (rate-limited): see Section 12.

5. **Operator load shedding**: see §12.4.

### 10.4 Realtime Subscriptions

- UI subscribes to: `READY` count, `RUNNING` by worker, `NEEDS_DECISION` count, recent events.
- Workers subscribe to `READY count > 0` and wake only when needed (no busy-wait).

### 10.5 Opinionated Defaults

- Backoff: exponential with jitter — 30s, 2m, 10m (cap).
- Concurrency: per `concurrency_key`, default limit 1 via Workpool pool configuration.
- Workflow timeout: 10 minutes default; configurable per command type via `constraints.timeout_ms`.

### 10.6 v2 Upgrade Path: Custom Leases

If Convex Workflow/Workpool limitations become blocking — capability-based routing, fine-grained priority ordering across pools, or lease-based reclamation for external workers — the v2 executor replaces the Workpool layer with custom lease infrastructure:

- **Atomic claim**: `claimNextWork({ workerId, capabilities })` — query eligible cards, atomically set `leasedTo`, `leaseUntilTs`, transition `READY → RUNNING`.
- **Heartbeats**: `renewLease({ cardId, workerId })` — extend lease during execution.
- **Completion with fence**: `completeWork({ cardId, workerId, outcome })` — validate `leasedTo == workerId` before writing results (prevents stale worker from overwriting a reclaimed card).
- **Stale lease recovery**: sweeper finds `RUNNING` cards where `leaseUntilTs < now`, transitions back to `READY` (or `FAILED` if reclaimed too many times).

The card model already includes `leasedTo`, `leaseUntilTs`, and `lastHeartbeatTs` fields (see §9.1) to support this upgrade without schema migration.

**Decision criteria for upgrading to v2 executor:**
- External (non-Convex) workers need to participate in the work queue.
- Capability-based routing is required (worker A handles email commands, worker B handles image generation).
- Priority ordering needs to span across command types with a single unified queue.
- Fine-grained lease timeouts per task type are needed (60s for fast tasks, 5m for long tasks).

Until one of these criteria is met, Convex Workflow + Workpool is the correct choice.

---

## 11) Storage / Persistence (Convex-native)

### 11.1 Bus Storage: `events` table

- Append-only; never update or delete.
- Primary access patterns: by `correlation_id`, by subject IDs, by `event_type` + time window.

**Schema (mirrors envelope):**

| Field | Type | Notes |
|-------|------|-------|
| `eventId` | string (ULID) | Primary identity |
| `tenantId` | string | Scope: tenant (required) |
| `projectId` | string | Scope: project (required) |
| `type` | string | Event type name |
| `version` | number | Schema version |
| `ts` | number | Milliseconds since epoch |
| `correlationId` | string | Chain identity |
| `causationId` | string? | Parent event |
| `commandId` | string? | Subject |
| `runId` | string? | Subject |
| `cardId` | string? | Subject |
| `decisionId` | string? | Subject |
| `idempotencyKey` | string? | For dedup |
| `producer` | object | Service + version |
| `tags` | object | Arbitrary labels |
| `payload` | object | Event-type-specific data |

**Indexes (v1 — add more only when needed):**

- `by_projectId_correlationId_ts` — trace full chains, project-isolated (replaces a bare `by_correlationId_ts` which would leak across projects at scale)
- `by_type_ts` — event feeds (cross-project is acceptable for type-based queries within a tenant; Convex deployment = tenant boundary)
- `by_projectId_ts` — replay queries, project-scoped time-range scans, retention sweeper

### 11.2 Derived Read Models (rebuildable from events)

**`commands`** (latest state per command):

| Field | Notes |
|-------|-------|
| `commandId`, `tenantId`, `projectId`, `status`, `latestRunId`, `lastEventId`, `updatedTs`, `priority`, `commandSpec` | |
| Indexes: `by_projectId_status_priority`, `by_projectId_updatedTs` | |

**`runs`** (attempt state):

| Field | Notes |
|-------|-------|
| `runId`, `tenantId`, `projectId`, `commandId`, `status`, `startedTs`, `endedTs`, `attempt`, `executor`, `error` | |
| Indexes: `by_commandId_startedTs`, `by_projectId_status_startedTs` | |

**`cards`** (work item state):

| Field | Notes |
|-------|-------|
| `cardId`, `tenantId`, `projectId`, `state`, `priority`, `title`, `spec`, `updatedTs`, `leasedTo`, `leaseUntilTs`, `attempt`, `retryAtTs`, `lastHeartbeatTs`, `capabilities` | |
| Indexes: `by_projectId_state_priority`, `by_projectId_updatedTs` | |

**`decisions`** (the decision queue):

| Field | Notes |
|-------|-------|
| `decisionId`, `tenantId`, `projectId`, `cardId`, `commandId`, `runId`, `state` (PENDING/CLAIMED/RENDERED/EXPIRED), `urgency`, `title`, `contextSummary`, `options`, `artifactRefs`, `sourceThread`, `expiresAt`, `fallbackOption`, `claimedBy`, `claimedUntil`, `renderedOption`, `renderedAt`, `renderedBy` | |
| Indexes: `by_projectId_state_urgency`, `by_projectId_renderedAt`, `by_claimedBy_state` | |

**`artifacts`** (registry / manifests):

| Field | Notes |
|-------|-------|
| `artifactId`, `tenantId`, `projectId`, `contentSha256`, `type`, `logicalName`, `byteSize`, `labels`, `provenance`, `createdAt` | |
| Indexes: `by_sha256`, `by_runId`, `by_projectId_commandId`, `by_projectId_logicalName_createdAt` | |

### 11.3 Artifact Blobs

Convex stores metadata + pointers; blobs live in object storage.

- `pointer`: `{ provider: "convex-files" | "s3" | "r2", bucket?, key }` — start with Convex file storage, migrate to S3/R2 when needed.
- Optional: signed URL generation for retrieval.

### 11.4 Consistency Model

- Writes are mutations that append an event and update one or more read models in the same transaction.
- UI subscribes to read models for fast rendering; deep audit queries `events`.

---

## 12) Notification Digest

The decision queue UI is the primary interface, but you're not always looking at it. Notifications consolidate decisions into a single channel.

### 12.1 Batched Decision Digest

Every N hours (configurable; default 2h), or on-demand, compile all PENDING decisions into a single summary message:

> **ClawOps: 4 decisions pending**
> 🔴 **2 urgent (now):** Approve digest publish, Confirm Nest schedule change
> 🟡 **1 today:** Review sync conflict in knowledge base
> ⚪ **1 whenever:** Archive old export files
> → [Open decision queue](link)

Sent to ONE channel of your choice (Slack, Discord, Telegram, email, etc.). Not per-bot, not per-platform. One place.

### 12.2 Escalation Ladder

| Time pending | Action |
|---|---|
| > 2 hours | Include in next digest batch |
| > 8 hours | Bump urgency by one level |
| > 24 hours | Final reminder, then auto-expire with fallback if defined |

### 12.3 Rate Limiting

- Maximum one notification per channel per hour (unless urgency is `now`).
- `now` urgency decisions trigger an immediate single-decision notification (still rate-limited to one per 5 minutes).

### 12.4 Operator Load Shedding

When the decision queue gets deep, the operator's attention is the scarce resource. Load shedding automatically defers low-priority work so the operator focuses on what matters.

**Rules (enforced by the sweeper):**

| Condition | Action |
|---|---|
| `now` backlog > 2 | Defer all new `whenever` decisions: auto-resolve with fallback if defined, or extend `expires_at` by 24h. Emit `DecisionDeferred` event. |
| `today` backlog > 10 | Stop escalating `whenever` decisions. Pause new `whenever` card creation (hold in `READY`, don't emit `DecisionRequested` until backlog clears). |
| `now` backlog > 5 | Alert via immediate notification regardless of rate limit. This is an emergency — the operator is falling behind on urgent work. |
| Any SLO p95 breached (§13.4) | Bump escalation ladder by one tier for affected urgency level. |

**`DecisionDeferred` event:** new event type (informational). Records: `decision_id`, reason ("load_shedding"), original urgency, deferred action taken. Ensures load shedding is traceable in the event log.

**Auto-recovery:** when the backlog drops below thresholds, the sweeper resumes normal behavior. Deferred `whenever` decisions re-enter the queue at their original urgency.

**Configuration:** all thresholds are configurable per project. Single operators may want tighter thresholds; teams may want looser ones.

---

## 13) Observability & Debugging

### 13.1 Event Chain Viewer

Fetch the full chain by `correlation_id` and render: Command → Runs → Decisions → Artifacts.

### 13.2 Structured Errors

`CommandFailed` includes structured error data:

```json
{
  "error": {
    "class": "ArtifactWriteError",
    "message": "Path escapes workspace root",
    "retryable": false,
    "details": { "path": "/workspace/shared/artifacts/..." }
  }
}
```

### 13.3 Decision Velocity Dashboard

Track and visualize:

- **Average decision response time** — how long decisions sit in the queue before you act.
- **Decision throughput** — decisions rendered per day/week.
- **Bottleneck sources** — which bots generate the most decisions, which command types block most often.
- **Expiration rate** — what percentage of decisions expire vs. get answered.
- **Queue depth over time** — are you keeping up or falling behind.

This turns the bottleneck from invisible to measurable. It's also a compelling demo: "I went from 20 lost threads to a 45-minute average decision time."

### 13.4 Decision SLOs (Service Level Objectives)

ClawOps tracks decision latency against configurable SLO targets. SLOs turn the velocity dashboard from informational into actionable — the system can alert, escalate, or load-shed when targets are at risk.

**Default SLO targets (configurable per project):**

| Urgency | p50 target | p95 target | Backlog threshold |
|---|---|---|---|
| `now` | < 5 minutes | < 15 minutes | ≤ 2 pending |
| `today` | < 2 hours | < 8 hours | ≤ 10 pending |
| `whenever` | < 24 hours | < 72 hours | ≤ 25 pending |

**How SLOs are tracked:**

- Decision latency = `renderedAt - requestedAt` (or `expiredAt - requestedAt` for expired decisions).
- The sweeper computes rolling p50/p95 per urgency level over a configurable window (default: 7 days).
- Results are written to a `slo_metrics` read model (rebuilt from events) and exposed via the `decisionVelocity` query.

**SLO breach behavior:**

- When p95 exceeds target: emit `SloBreached` event (new event type, informational). Dashboard shows a warning.
- When backlog threshold exceeded: trigger load shedding (see §12.4).
- SLO breaches are *signals*, not hard failures. They drive escalation and load shedding, not blocking.

---

## 14) Security, Privacy & Compliance

ClawOps stores rich context (decision summaries, artifacts, event payloads) that may contain secrets, PII, or sensitive business data. For a shared skill used across teams and tenants, this requires explicit policies — not afterthoughts.

### 14.1 Access Control Model

ClawOps uses explicit scope fields on every entity: **`tenant_id`** and **`project_id`**. These are required fields on every event, card, decision, command, and artifact — not optional tags.

**Scope hierarchy: tenant → project → role**

- **Tenant** (`tenant_id`): the top-level isolation boundary. Maps to a Convex deployment. All data is scoped to a tenant. There is no cross-tenant data access. Every query and mutation implicitly filters by the caller's `tenant_id`.
- **Project** (`project_id`): a grouping within a tenant (e.g., "content-pipeline", "home-automation", "finance-bots"). A project owns a set of cards, commands, decisions, and artifacts. Operators can be assigned to one or more projects. Dashboards filter by project.
- **Role**: defines what actions a user can take within a project.

**RBAC roles (v1):**

| Role | Permissions |
|---|---|
| `owner` | All mutations + project settings + retention policy + user management |
| `operator` | Claim and render decisions, view events/artifacts, trigger commands |
| `viewer` | Read-only access to decision queue, events, artifacts (subject to redaction policy) |
| `bot` | Emit events, produce artifacts, request decisions. Cannot render decisions. |

**Enforcement:**

- v1 enforces `tenant_id` isolation on every query and mutation (hard boundary).
- v1 enforces `project_id` filtering on all read paths (queries, subscriptions). Mutations validate that the caller has a role in the target project.
- Role checks are implemented as a Convex middleware wrapper that runs before every mutation and query. The middleware reads the caller's identity (Convex auth) and looks up their project roles from a `project_members` table.
- For single-operator setups, the `clawops init` script creates one project and assigns the installer as `owner`. RBAC adds no overhead in this case — every call passes the check.

### 14.2 Secrets in Payloads

**Rule: never store raw secrets in event payloads or artifact content.**

- API keys, tokens, passwords, and connection strings must be stored in Convex environment variables or an external secret manager and referenced by name in payloads (e.g., `{ "credential_ref": "env:GITHUB_TOKEN" }`, never `{ "token": "ghp_..." }`).
- The `requestCommand` and `requestDecision` mutations should validate payloads against a denylist of known secret patterns (e.g., regex for `ghp_`, `sk-`, `Bearer`, `-----BEGIN`) and reject writes that match with a clear error: "Payload appears to contain a raw secret. Use a credential reference instead."
- Bot adapters should strip or redact sensitive headers/tokens before including source context in decision requests.

### 14.3 PII Handling + Redaction

Event payloads and decision context summaries may contain PII (names, emails, identifiers). ClawOps provides:

- **Sensitivity labels**: every event and artifact can carry a `sensitivity` field in its `tags`: `public`, `internal`, `confidential`, `restricted`. Default is `internal`.
- **Redaction policy**: a configurable function that runs at *read time* (not write time — the append-only log is never mutated). When a query requests events or decision details, the redaction policy can mask or omit fields based on the caller's access level and the item's sensitivity label. Example: `confidential` events return `payload: "[REDACTED]"` for read-only dashboard viewers.
- **Audit log for access**: reads of `restricted` or `confidential` events/artifacts should themselves be logged (a lightweight access event, not a full bus event) to support compliance audits.

### 14.4 Retention Policies

Not all data should live forever. Defaults (configurable per-tenant):

| Data type | Default retention | Notes |
|---|---|---|
| Events | 90 days | After retention window, archive to cold storage or delete. Terminal events (CommandSucceeded/Failed, DecisionRendered) may be kept longer for audit. |
| Decision requests | 90 days | Rendered/expired decisions are historical. |
| Artifact manifests | 90 days | Manifests are small; keep them as long as events. |
| Artifact blobs | 30 days (transient), 90 days (persisted) | Transient blobs (scratch, intermediate logs) expire first. Persisted blobs follow the manifest. |
| Cards | 30 days after terminal state | DONE/FAILED cards are historical. |

Retention is enforced by a scheduled Convex function (similar to the sweeper) that archives then deletes data past its retention window. The event log's append-only invariant applies to *active* data; archived data moves to cold storage.

**Archive contract (critical for replay):**

The "rebuild read models from events" guarantee (§19) only holds if archived events remain accessible. Retention must archive-then-delete, never delete-only.

- **Archive format**: NDJSON (newline-delimited JSON), one event per line, ordered by `ts` ascending. One file per day per project: `archives/{tenant_id}/{project_id}/events/{YYYY-MM-DD}.ndjson`.
- **Archive destination**: Convex file storage (v1); S3/R2/GCS for production scale. Configurable via `CLAWOPS_ARCHIVE_PROVIDER` environment variable.
- **Archive procedure**: the retention sweeper queries events older than the retention window, writes them to an archive file, verifies the write succeeded (read-back and count check), then deletes the originals from the `events` table.
- **Archive index**: a lightweight `event_archives` table records: `{ archiveId, tenantId, projectId, dateRange, eventCount, storagePointer, archivedAt }`. This lets the replay system find the right archive files without scanning storage.
- **Integrity**: each archive file includes a trailing checksum line: `{"_checksum": "sha256_of_all_preceding_lines"}`. The replay system validates this before processing.

If an adopter chooses to disable archival and hard-delete events, the design doc should make clear: **full read model rebuild is no longer possible for data outside the retention window.** This is an explicit trade-off the adopter must acknowledge in configuration.

### 14.5 Encrypted Artifacts

For artifacts containing sensitive content (financial data, health records, credentials):

- **At rest**: Convex file storage provides default encryption at rest. For artifacts requiring stronger guarantees, use client-side encryption before upload: the bot encrypts the blob, stores the encrypted bytes as the artifact, and stores the encryption key reference (not the key itself) in the manifest's `labels` field (e.g., `{ "encrypted": true, "key_ref": "vault:artifacts/dec_01J" }`).
- **In transit**: all Convex communication is TLS-encrypted by default.
- **Manifest metadata**: the artifact manifest (type, logical name, labels, provenance) is stored unencrypted for indexing. Do not put sensitive content in manifest fields — keep it in the blob.

### 14.6 Multi-tenant Considerations (skill packaging)

When ClawOps ships as a shared skill, adopters may run it in multi-project or multi-team configurations. The skill provides:

- Explicit `tenant_id` and `project_id` fields on every entity (not optional tags).
- `project_id`-prefixed indexes on all read model tables for efficient project-scoped queries.
- A `project_members` table mapping users to projects with roles.
- Auth middleware that validates tenant/project/role on every mutation and query.
- Default sensitivity labels of `internal` so new adopters don't accidentally expose data.
- A `clawops init` script that creates the initial project and owner assignment.

---

## 15) Convex Function Surface (v1)

No REST API in v1. All consumers are Convex functions and subscriptions. Non-Convex bots use the Convex direct adapter (which wraps Convex client calls); an HTTP adapter is deferred to v1.5.

### Mutations

| Function | Purpose |
|---|---|
| `requestCommand(spec)` | Emit `CommandRequested`, create card, enqueue Workpool job |
| `requestDecision(params)` | Create decision request, transition card to `NEEDS_DECISION` |
| `claimDecision({ decisionId })` | Claim a decision for review; userId derived from auth context (see §6.6) |
| `renewDecisionClaim({ decisionId })` | Extend claim while operator is still reviewing; userId from auth context (see §6.6) |
| `renderDecision({ decisionId, optionKey, note? })` | Compare-and-set: record choice if PENDING/CLAIMED; caller identity from auth context (see §6.5) |
| `createCard(spec)` | Create a new card directly |

### Queries

| Function | Purpose |
|---|---|
| `pendingDecisions({ urgency? })` | Decision queue inbox |
| `decisionDetail({ decisionId })` | Full context bundle for one decision |
| `cardsByState({ state, limit? })` | Cards filtered by state |
| `eventChain({ projectId, correlationId })` | Full event trace (uses `by_projectId_correlationId_ts` index) |
| `artifactsForRun({ runId })` | All artifacts from one execution |
| `decisionVelocity({ windowDays? })` | Dashboard metrics |

### Subscriptions (realtime)

| Subscription | Purpose |
|---|---|
| `pendingDecisionCount` | Badge count for UI |
| `activeWork` | What's currently running |
| `recentEvents({ limit })` | Live event feed |

---

## 16) Bot Adapter Interface

This is the integration surface for existing bots. Wiring a bot into ClawOps should be three function calls, not a rewrite.

```ts
interface ClawOpsAdapter {
  /**
   * Bot calls this when it needs human input.
   * Creates a DecisionRequest and blocks the card.
   * Returns the decision_id for tracking.
   */
  requestDecision(params: {
    title: string;
    contextSummary: string;
    options: Array<{ key: string; label: string; consequence: string }>;
    urgency: "now" | "today" | "whenever";
    artifactRefs?: string[];
    expiresAt?: string;
    fallbackOption?: string;
    sourceThread?: { platform: string; channelId: string; messageId: string };
  }): Promise<string>;

  /**
   * Bot calls this to wait for the decision.
   * Returns when the human decides or the decision expires.
   */
  awaitDecision(
    decisionId: string,
    timeoutMs?: number
  ): Promise<{
    outcome: "rendered" | "expired";
    selectedOption: string;
    note?: string;
  }>;

  /**
   * Bot calls this to register an artifact produced during work.
   */
  reportArtifact(
    runId: string,
    artifact: {
      content: Buffer | string;
      type: string;
      logicalName: string;
      labels?: Record<string, string>;
    }
  ): Promise<string>;

  /**
   * Bot calls this to emit a command request.
   */
  requestCommand(spec: CommandSpec): Promise<string>;
}
```

### Adapter Implementations

- **Convex direct (v1)**: for bots running as Convex actions (call mutations directly). This is the primary and recommended integration path.
- **HTTP wrapper (v1.5)**: thin HTTP layer over the Convex mutations for bots running outside Convex (e.g., existing Node/Python bots on a separate server). Deferred because it introduces authentication, rate-limiting, and API versioning concerns that the Convex-direct path avoids. Build it when a non-Convex bot needs to integrate.

---

## 17) Worked Example (end-to-end)

**Scenario**: A digest bot runs a weekly compilation. It finds questionable content and needs the operator's approval.

### Event sequence

```
1. CommandRequested
   command_type: "digest.compile", correlation_id: corr_X
   idempotency_key: "digest-compile-2026-w09"

2. CardCreated
   card_id: card_A, title: "Weekly digest compile + publish"
   state: READY, priority: 30
   (emitted in the same mutation as CommandRequested)

3. CardTransitioned (READY → RUNNING)
   card_id: card_A
   (emitted when Workpool picks up the job)

4. CommandStarted
   run_id: run_1, correlation_id: corr_X
   (emitted in the same mutation as CardTransitioned)

5. ArtifactProduced
   artifact_id: art_digest, logical_name: "digest-2026-w09.md"
   type: text/markdown, byte_size: 8432

6. ArtifactProduced
   artifact_id: art_flags, logical_name: "flagged-items.json"
   type: application/json, byte_size: 512

7. DecisionRequested
   decision_id: dec_1, card_id: card_A
   title: "Approve weekly digest for publishing"
   context_summary: "DigestBot compiled 12 articles. 3 flagged as potentially outdated."
   options: [approve, edit, reject]
   urgency: "today"
   artifact_refs: [art_digest, art_flags]
   expires_at: 2026-03-01T09:00:00Z, fallback_option: "reject"

8. CardTransitioned (RUNNING → NEEDS_DECISION)
   reason: "awaiting human approval", decision_id: dec_1

   ── 3 hours pass. The operator opens the decision queue. ──
   ── Sees: title, context summary, digest preview, flagged items. ──
   ── Clicks into the decision (auto-claims it). ──

9. DecisionClaimed
   decision_id: dec_1, claimed_by: "user:alice"
   claimed_until: 2026-02-28T19:20:00Z

   ── Reviews artifacts, clicks "Publish as-is". ──

10. DecisionRendered
   decision_id: dec_1, selected_option: "approve"
   rendered_by: "user:alice", rendered_at: 2026-02-28T19:15:00Z

11. CardTransitioned (NEEDS_DECISION → RUNNING)
    reason: "decision rendered: approve"

12. CommandSucceeded
    run_id: run_1, summary: "Digest published to blog + newsletter sent"

13. CardTransitioned (RUNNING → DONE)
```

### What the operator experienced

They opened one UI, saw "Approve weekly digest" with urgency "today", previewed the digest markdown and flagged items inline, clicked "approve", and went back to their day. No switching between chat platforms, no scrolling through bot threads, no lost context.

---

## 18) Skill Packaging

ClawOps is designed to ship as a reusable skill for anyone running AI agents who hits the "I'm the bottleneck" problem.

### What the skill provides

- Convex schema definitions (events, cards, decisions, artifacts, commands, runs)
- Convex functions (mutations, queries, subscriptions from Section 15)
- Executor integration (Convex Workflow + Workpool wrappers with event emission)
- Decision queue web UI (Convex-subscribed dashboard)
- Notification digest function (configurable channel)
- Bot adapter (Convex direct in v1; HTTP wrapper in v1.5)

### What the user brings

- A Convex project
- One or more bots / agent handlers (any language/framework)
- A notification channel (Slack, Discord, Telegram, email, etc.)

### Install story (target)

```bash
# 1. Add ClawOps to your Convex project
npx clawops init

# 2. Wire your bot's decision points
import { clawops } from "./clawops";
const decisionId = await clawops.requestDecision({ ... });
const outcome = await clawops.awaitDecision(decisionId);

# 3. Configure notifications
# Set CLAWOPS_NOTIFY_CHANNEL in your Convex environment

# 4. Deploy
npx convex deploy
```

### Skill boundary

ClawOps does NOT own your bot logic, your command handlers, or your platform integrations. It owns the coordination layer: "what work exists, who's doing it, what's blocked on a human, and what did it produce."

---

## 19) Replay & Repair Playbook

The event log is the source of truth. All read models (commands, runs, cards, decisions, artifacts) are derived and can be rebuilt. This section documents how.

### 19.1 When to Rebuild

- A bug in a projector (the code that updates read models from events) wrote incorrect derived state.
- A new read model is added and needs to be backfilled from historical events.
- Data corruption in a read model table (Convex mutation failure, partial write).
- Schema migration that requires recomputing derived fields.

### 19.2 Rebuild Procedure

> **Note:** If the rebuild requires events older than the retention window, follow §19.6 (Replay from Cold Archive) which extends this procedure to span both archived and live events.

**Step 1: Identify scope.**
Determine which read model(s) need rebuilding and the time range of affected events. Use the event chain viewer (§13.1) to inspect the corruption boundary.

**Step 2: Snapshot current state (safety net).**
Export the affected read model table(s) before modifying them. Convex provides snapshot export; alternatively, query all rows and write to a backup table.

**Step 3: Clear the target read model.**
Delete all rows in the affected read model table (or just the affected project/time range if the rebuild is scoped). For large tables, batch the deletes to avoid mutation timeouts.

**Step 4: Replay events.**
Run a Convex action that:
1. Queries `events` table ordered by `ts` ascending, filtered by scope (project, time range).
2. For each event, calls the projector function that computes the read model update.
3. Writes the derived state to the read model table.
4. Logs progress (events processed, rows written) to a replay status table or console.

**Step 5: Validate.**
Compare the rebuilt state against known-good checkpoints: spot-check specific `command_id` / `decision_id` values, verify counts match event counts, confirm that the latest state for active cards/decisions is correct.

**Step 6: Resume normal operation.**
Once validated, the read model is live. New events will be projected normally by the standard mutation path.

### 19.3 Replay Implementation

```ts
// convex/replay.ts — Convex action for read model rebuild

async function replayEvents(ctx, args: {
  targetModel: "commands" | "runs" | "cards" | "decisions" | "artifacts",
  projectId?: string,
  sinceTs?: number,
  untilTs?: number,
  batchSize?: number,  // default 100
}) {
  let cursorTs = args.sinceTs ?? 0;
  let cursorEventId: string | undefined = undefined;
  let processed = 0;

  while (true) {
    // Query next batch using composite (ts, eventId) cursor.
    // Uses >= on ts and excludes already-seen eventIds at the boundary
    // timestamp to avoid skipping events with identical timestamps.
    const events = await ctx.runQuery(internal.events.listByTsRange, {
      sinceTs: cursorTs,
      afterEventId: cursorEventId,  // exclude this and earlier eventIds at sinceTs
      untilTs: args.untilTs,
      projectId: args.projectId,
      limit: args.batchSize ?? 100,
    });

    if (events.length === 0) break;

    // Apply each event to the target read model
    for (const event of events) {
      await ctx.runMutation(internal.projectors[args.targetModel], { event });
      processed++;
    }

    const last = events[events.length - 1];
    cursorTs = last.ts;
    cursorEventId = last.eventId;
    console.log(`Replayed ${processed} events, cursor at (${cursorTs}, ${cursorEventId})`);
  }

  return { processed };
}
```

### 19.4 Guardrails

- **Idempotent projectors**: projector functions must be idempotent. Replaying the same event twice must produce the same result. Use upsert semantics (insert or update by primary key), never blind insert.
- **Event ordering**: always replay in `ts` ascending order. Out-of-order replay can produce incorrect state (e.g., a `CommandSucceeded` before `CommandStarted`).
- **Same-timestamp safety**: multiple events can share a timestamp (ms granularity). The replay cursor uses a composite `(ts, eventId)` pair — advancing on `eventId` (ULID, lexicographically sortable) within the same timestamp. The `listByTsRange` query must return events ordered by `(ts ASC, eventId ASC)` and support an `afterEventId` parameter that excludes events at the boundary timestamp that have already been processed.
- **No side effects during replay**: projectors must not emit new events, send notifications, or trigger external actions during replay. Add a `replay: boolean` flag to the projector context and gate side effects on it.
- **Batch size**: keep batch sizes small enough to avoid Convex mutation timeouts (default 100 events per batch). The replay action loops until all events are processed.
- **Monitoring**: log progress to a `replay_jobs` table with `{ jobId, targetModel, status, eventsProcessed, startedAt, completedAt }` so you can track and resume interrupted replays.

### 19.5 Preventive Measures

- **Contract tests** (§4.3) catch projector bugs before they ship.
- **Event count reconciliation**: a scheduled function that periodically compares event counts by type against read model row counts. Emit `ReconciliationDrift` event if mismatches are found.
- **Immutable event log**: never modify events. If an event was emitted incorrectly, emit a compensating event (e.g., `CommandCorrected`) rather than editing the original.

### 19.6 Replay from Cold Archive

If the rebuild requires events that have been archived by the retention policy (§14.4), the replay must span both cold archives and live events. This is the full procedure:

**Step 1: Identify required date range.**
Determine the earliest event needed for the rebuild. If it's older than the retention window, cold archive access is required.

**Step 2: Locate archive files.**
Query the `event_archives` table (§14.4) for archives covering the required date range and project.

**Step 3: Validate archive integrity.**
For each archive file, read the trailing checksum line and verify it against the SHA256 of all preceding lines. If validation fails, stop and investigate — replaying from a corrupted archive produces incorrect state.

**Step 4: Replay archived events first.**
Stream events from NDJSON archive files in chronological order (oldest date file first). For each event, call the same idempotent projector function used for live events. Process one file at a time to keep memory bounded.

```ts
async function replayFromArchive(ctx, args: {
  targetModel: string,
  archiveIds: string[],  // ordered by date ascending
}) {
  let processed = 0;
  for (const archiveId of args.archiveIds) {
    const archive = await ctx.runQuery(internal.archives.get, { archiveId });
    const content = await fetchArchiveFile(archive.storagePointer);
    const lines = content.split('\n').filter(l => !l.startsWith('{"_checksum'));

    for (const line of lines) {
      const event = JSON.parse(line);
      await ctx.runMutation(internal.projectors[args.targetModel], {
        event,
        replay: true,  // suppresses side effects
      });
      processed++;
    }
  }
  return { processed };
}
```

**Step 5: Replay live events.**
After all archive files are processed, run the standard replay (§19.3) for events still in the live `events` table, starting from the timestamp where the last archive file ended.

**Step 6: Validate and resume.**
Same as §19.2 steps 5–6.

**Key constraint:** the archive format (NDJSON, ordered by `ts`) and the live events table (also ordered by `ts`) must produce a seamless, monotonically ordered event stream when concatenated. The retention sweeper must guarantee no gaps: an event is either in the live table or in an archive, never in neither and never in both.

---

## 20) Open Questions (decisions to lock)

1. **Priority direction**: 0 = highest priority (recommended; matches urgency intuition).
2. **Card → command mapping**: 1:1 for v1. Sequential multi-command cards can be added later.
3. **Artifact retention**: TTL by label? By type? Decide when storage costs become real.
4. **Decision options**: free-form text input as an option type? Or only predefined choices in v1?
5. **Notification channel adapter**: which platform first? (Recommendation: whichever your team uses most.)
6. **Decision claim duration**: 5 minutes default — is this too short for complex decisions that require reading artifacts?

---

## 21) Implementation Plan

### Phase 1: Event Bus + Decision Requests (the foundation)

- Define JSON schemas with `scope.tenant_id` and `scope.project_id` on every entity (event envelope, command spec, decision request, artifact manifest, card).
- Implement Convex `events` table with append-only mutations and `by_projectId_correlationId_ts` + `by_type_ts` + `by_projectId_ts` indexes.
- Implement `decisions` read model with `requestDecision`, `claimDecision`, and `renderDecision` mutations (with compare-and-set per §6.5 and claiming per §6.6).
- Implement `project_members` table and auth middleware for RBAC (§14.1).
- Implement secret-in-payload validation (denylist patterns per §14.2).
- Write contract tests for canonical event sequences (§4.3).
- Instrument ONE existing bot to create decision requests instead of waiting in a thread.
- Basic Convex query for pending decisions (no UI yet — query from CLI or Convex dashboard).

### Phase 2: Decision Queue UI + Notification Digest

- Build a simple Convex-powered web dashboard: pending decisions with context bundles, claim indicators, one-click resolution.
- Implement batched notification digest to one channel.
- Implement escalation ladder and operator load shedding (§12.4) in the sweeper.
- Implement SLO tracking and breach detection (§13.4).
- Realtime subscriptions for decision count badge.

### Phase 3: Executor (Convex Workflow + Workpool)

- Implement Workpool pools per command type with concurrency limits.
- Implement Workflow wrapper that handles: event emission at each step, artifact provenance, decision pause/resume (signal or poll-based).
- Implement sweeper as Convex cron (retry release, decision expiration, load shedding).
- Migrate bot work processing from ad-hoc to Workflow-based.
- Implement artifact store (Convex file storage) + manifest registry.
- Write replay/repair runbook and validate read model rebuild (§19).

### Phase 4: Skill Packaging

- Extract reusable Convex schema, functions, and adapter.
- Write the bot adapter interface (Convex direct for v1; HTTP wrapper for v1.5).
- Implement retention policy sweeper (§14.4).
- Implement redaction policy for read-time PII masking (§14.3).
- Implement event count reconciliation (§19.5).
- Document install story and configuration (including `clawops init` for project + owner setup).
- Build decision velocity dashboard with SLO visualization.
- Ship as a community skill.
