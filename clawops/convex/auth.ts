import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { RbacRole } from "./schema";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});

// ── RBAC Middleware (§14.1) ──────────────────────────────────────

export type Role = RbacRole;

export type AuthContext = {
  userId: string;
  tenantId: string;
  projectId: string;
  role: Role;
};

const ALL_ROLES: Role[] = ["owner", "operator", "viewer", "bot"];

// Args type for auth-wrapped handlers. projectId is typed; other properties
// pass through as `any` since Convex validates them at runtime via arg validators.
type AuthArgs = { projectId: string } & Record<string, any>;

/**
 * Middleware wrapper for mutations. Resolves caller identity, validates
 * project membership, and enforces RBAC roles before calling the handler.
 * Owner role always passes any role check.
 */
export function withAuth<Result>(
  opts: { roles: Role[] },
  handler: (ctx: MutationCtx, args: AuthArgs, auth: AuthContext) => Promise<Result>,
): (ctx: MutationCtx, args: AuthArgs) => Promise<Result> {
  return async (ctx, args) => {
    const authCtx = await resolveAuth(ctx, args.projectId);
    if (authCtx.role !== "owner" && !opts.roles.includes(authCtx.role)) {
      throw new Error(
        `Insufficient permissions: requires ${opts.roles.join(" or ")}`,
      );
    }
    return handler(ctx, args, authCtx);
  };
}

/**
 * Middleware wrapper for queries. Same as withAuth but typed for QueryCtx.
 */
export function withAuthQ<Result>(
  opts: { roles: Role[] },
  handler: (ctx: QueryCtx, args: AuthArgs, auth: AuthContext) => Promise<Result>,
): (ctx: QueryCtx, args: AuthArgs) => Promise<Result> {
  return async (ctx, args) => {
    const authCtx = await resolveAuth(ctx, args.projectId);
    if (authCtx.role !== "owner" && !opts.roles.includes(authCtx.role)) {
      throw new Error(
        `Insufficient permissions: requires ${opts.roles.join(" or ")}`,
      );
    }
    return handler(ctx, args, authCtx);
  };
}

async function resolveAuth(
  ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string; tokenIdentifier?: string } | null> }; db: QueryCtx["db"] },
  projectId: string,
): Promise<AuthContext> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  const userId = identity.subject ?? identity.tokenIdentifier!;

  const member = await ctx.db
    .query("project_members")
    .withIndex("by_userId_projectId", (q) =>
      q.eq("userId", userId).eq("projectId", projectId),
    )
    .unique();

  if (!member) {
    throw new Error("Not a member of this project");
  }

  return {
    userId,
    tenantId: member.tenantId,
    projectId: member.projectId,
    role: member.role as Role,
  };
}

export { ALL_ROLES };
