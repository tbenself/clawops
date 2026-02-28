# ClawOps

A decision queue for humans in AI agent workflows. Built on [Convex](https://convex.dev/).

Bots block on human decisions across scattered threads and platforms. ClawOps provides a unified **Decision Queue** — a single, prioritized inbox where every bot-blocked-on-human decision surfaces with full context, artifacts, and one-click resolution.

## Architecture

**Backend** (Convex)
- **Event Bus** — append-only log with correlation chains, idempotency, and secret detection
- **Commands & Cards** — work item lifecycle with a strict state machine (READY → RUNNING → DONE/FAILED/NEEDS_DECISION)
- **Decision Queue** — PENDING → CLAIMED → RENDERED flow with urgency levels (now/today/whenever), claim leasing, and compare-and-set rendering
- **Artifact Store** — content-addressed (SHA256) immutable artifacts with Convex file storage, per-project dedup, and provenance linking
- **Sweeper** — periodic maintenance: retry release, decision expiration, claim reclamation, load shedding
- **Bot Adapter** — thin 4-function interface (`requestCommand`, `requestDecision`, `reportArtifact`, `awaitDecision`)
- **RBAC** — project-scoped roles: owner, operator, viewer, bot

**Frontend** (React + Tailwind)
- Decision queue dashboard with real-time subscriptions
- Auto-claim on open, heartbeat renewal, one-click rendering
- Artifact viewer with download links
- Event chain timeline
- Convex Auth (email/password)

## Getting Started

```bash
npm install
npm run dev
```

This starts both the Vite frontend and Convex backend in parallel.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend + backend |
| `npm run dev:frontend` | Start Vite dev server only |
| `npm run dev:backend` | Start Convex dev server only |
| `npm run build` | TypeScript check + Vite build |
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |

## Project Structure

```
convex/           # Convex backend
  schema.ts       # Table definitions and validators
  auth.ts         # Convex Auth + RBAC middleware
  events.ts       # Event bus (append-only log)
  cards.ts        # Cards + state machine + commands
  decisions.ts    # Decision queue lifecycle
  artifacts.ts    # Artifact storage (SHA256, blob, dedup)
  commands.ts     # Command request + read model
  adapter.ts      # Bot adapter interface
  sweeper.ts      # Periodic maintenance
  projectSetup.ts # Project bootstrapping
  projectMembers.ts # Member management
  *.test.ts       # 147 tests

src/              # React frontend
  App.tsx         # Dashboard shell + auth
  pages/
    DecisionQueue.tsx  # Decision queue list
  components/
    DecisionDetail.tsx # Decision detail + rendering
```

## Bot Adapter Interface

Bots interact through 4 functions:

```typescript
// Request a new command (creates card in READY)
const { commandId, cardId } = await requestCommand({ projectId, title, commandSpec, ... });

// Report an artifact (content-addressed, deduped)
const { artifactId } = await reportArtifact({ projectId, content, encoding, type, logicalName, ... });

// Request a human decision (creates decision in PENDING)
const { decisionId } = await requestDecision({ projectId, cardId, commandId, title, options, ... });

// Poll for decision outcome
const result = await awaitDecision({ projectId, decisionId });
// result: { status: "pending" | "claimed" | "rendered" | "expired", selectedOption?, ... }
```

## Tech Stack

- [Convex](https://convex.dev/) — backend (database, real-time, scheduled functions)
- [React 19](https://react.dev/) — frontend
- [Tailwind CSS 4](https://tailwindcss.com/) — styling
- [Convex Auth](https://labs.convex.dev/auth) — authentication
- [Vite](https://vite.dev/) — build tooling
- [Vitest](https://vitest.dev/) + [convex-test](https://github.com/get-convex/convex-test) — testing
