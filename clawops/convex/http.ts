import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// ── Convex Auth routes ──────────────────────────────────────
auth.addHttpRoutes(http);

// ── Bot HTTP API ────────────────────────────────────────────
// External bots authenticate with Bearer CLAWOPS_BOT_SECRET.
// All routes delegate to internal functions (no RBAC — the
// shared secret IS the auth).

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkSecret(request: Request): boolean {
  const secret = process.env.CLAWOPS_BOT_SECRET;
  if (!secret) return false;
  return request.headers.get("Authorization") === `Bearer ${secret}`;
}

// POST /api/requestCommand
http.route({
  path: "/api/requestCommand",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkSecret(request)) return json({ error: "Unauthorized" }, 401);
    try {
      const body = await request.json();
      const project = await ctx.runQuery(internal.projectSetup._httpLookupProject, {
        projectId: body.projectId,
      });
      if (!project) return json({ error: "Project not found" }, 404);

      const result = await ctx.runMutation(internal.commands._httpRequestCommand, {
        tenantId: project.tenantId,
        projectId: body.projectId,
        correlationId: body.correlationId,
        title: body.title,
        commandSpec: body.commandSpec,
        capabilities: body.capabilities,
        idempotencyKey: body.idempotencyKey,
      });
      return json(result);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }),
});

// POST /api/requestDecision
http.route({
  path: "/api/requestDecision",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkSecret(request)) return json({ error: "Unauthorized" }, 401);
    try {
      const body = await request.json();
      const project = await ctx.runQuery(internal.projectSetup._httpLookupProject, {
        projectId: body.projectId,
      });
      if (!project) return json({ error: "Project not found" }, 404);

      const result = await ctx.runMutation(internal.decisions._httpRequestDecision, {
        tenantId: project.tenantId,
        projectId: body.projectId,
        cardId: body.cardId,
        commandId: body.commandId,
        runId: body.runId,
        correlationId: body.correlationId,
        causationId: body.causationId,
        urgency: body.urgency,
        title: body.title,
        contextSummary: body.contextSummary,
        options: body.options,
        artifactRefs: body.artifactRefs,
        sourceThread: body.sourceThread,
        expiresAt: body.expiresAt,
        fallbackOption: body.fallbackOption,
      });
      return json(result);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }),
});

// POST /api/reportArtifact
http.route({
  path: "/api/reportArtifact",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkSecret(request)) return json({ error: "Unauthorized" }, 401);
    try {
      const body = await request.json();
      const project = await ctx.runQuery(internal.projectSetup._httpLookupProject, {
        projectId: body.projectId,
      });
      if (!project) return json({ error: "Project not found" }, 404);

      const result = await ctx.runAction(internal.artifacts._httpReportArtifact, {
        tenantId: project.tenantId,
        projectId: body.projectId,
        content: body.content,
        encoding: body.encoding,
        type: body.type,
        logicalName: body.logicalName,
        labels: body.labels,
        commandId: body.commandId,
        runId: body.runId,
        correlationId: body.correlationId,
        links: body.links,
      });
      return json(result);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }),
});

// POST /api/awaitDecision
http.route({
  path: "/api/awaitDecision",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkSecret(request)) return json({ error: "Unauthorized" }, 401);
    try {
      const body = await request.json();
      const result = await ctx.runQuery(internal.adapter._httpAwaitDecision, {
        projectId: body.projectId,
        decisionId: body.decisionId,
      });
      return json(result);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }),
});

export default http;
