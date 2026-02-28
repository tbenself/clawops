# ClawOps

Convex-native decision queue for AI agent workflows. Full design doc: docs/design.md

## Conventions

- All entities require scope.tenant_id and scope.project_id
- Event bus is append-only — never update or delete events
- Projectors must be idempotent (replay-safe)
- Auth identity comes from ctx.auth, never from input params
- Use Convex Workflow + Workpool for execution in v1 (no custom leases)
