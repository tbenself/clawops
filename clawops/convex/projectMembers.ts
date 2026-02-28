import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { rbacRole } from "./schema";
import { withAuth, withAuthQ, ALL_ROLES } from "./auth";

// ── addMember (owner only) ──────────────────────────────────────

export const addMember = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    role: rbacRole,
  },
  handler: withAuth({ roles: ["owner"] }, async (ctx, args, auth) => {
    // Check if already a member
    const existing = await ctx.db
      .query("project_members")
      .withIndex("by_userId_projectId", (q) =>
        q.eq("userId", args.userId).eq("projectId", args.projectId),
      )
      .unique();

    if (existing) {
      throw new Error(`User ${args.userId} is already a member of this project`);
    }

    await ctx.db.insert("project_members", {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      userId: args.userId,
      role: args.role,
    });

    return { userId: args.userId, role: args.role };
  }),
});

// ── removeMember (owner only) ───────────────────────────────────

export const removeMember = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
  },
  handler: withAuth({ roles: ["owner"] }, async (ctx, args, auth) => {
    const member = await ctx.db
      .query("project_members")
      .withIndex("by_userId_projectId", (q) =>
        q.eq("userId", args.userId).eq("projectId", args.projectId),
      )
      .unique();

    if (!member) {
      throw new Error(`User ${args.userId} is not a member of this project`);
    }

    // Cannot remove the last owner
    if (member.role === "owner") {
      const owners = await ctx.db
        .query("project_members")
        .withIndex("by_projectId_role", (q) =>
          q.eq("projectId", args.projectId).eq("role", "owner"),
        )
        .collect();

      if (owners.length <= 1) {
        throw new Error("Cannot remove the last owner of a project");
      }
    }

    await ctx.db.delete(member._id);

    return { removed: args.userId };
  }),
});

// ── listMembers (any role) ──────────────────────────────────────

export const listMembers = query({
  args: {
    projectId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (ctx, args, _auth) => {
    return await ctx.db
      .query("project_members")
      .withIndex("by_projectId_role", (q) =>
        q.eq("projectId", args.projectId),
      )
      .collect();
  }),
});

// ── getMyRole (any role) ────────────────────────────────────────

export const getMyRole = query({
  args: {
    projectId: v.string(),
  },
  handler: withAuthQ({ roles: ALL_ROLES }, async (_ctx, _args, auth) => {
    return { role: auth.role, userId: auth.userId };
  }),
});
