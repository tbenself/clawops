import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ── initProject — bootstrap entry point (§14.1) ─────────────────

export const initProject = mutation({
  args: {
    tenantId: v.string(),
    projectId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    const userId = identity.subject ?? identity.tokenIdentifier!;

    // Reject if project already exists
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .unique();

    if (existing) {
      throw new Error(`Project already exists: ${args.projectId}`);
    }

    const now = Date.now();

    // Create project record
    await ctx.db.insert("projects", {
      tenantId: args.tenantId,
      projectId: args.projectId,
      name: args.name,
      createdAt: now,
      createdBy: userId,
    });

    // Assign caller as owner
    await ctx.db.insert("project_members", {
      tenantId: args.tenantId,
      projectId: args.projectId,
      userId,
      role: "owner",
    });

    return { projectId: args.projectId };
  },
});

// ── myProjects — list projects for the current user ───────────

export const myProjects = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = identity.subject ?? identity.tokenIdentifier!;

    const memberships = await ctx.db
      .query("project_members")
      .withIndex("by_userId_projectId", (q) => q.eq("userId", userId))
      .collect();

    const projects = await Promise.all(
      memberships.map(async (m) => {
        const project = await ctx.db
          .query("projects")
          .withIndex("by_projectId", (q) => q.eq("projectId", m.projectId))
          .unique();
        return project ? { ...project, role: m.role } : null;
      }),
    );

    return projects.filter(Boolean);
  },
});
