// Bot Adapter Interface (§16)
//
// Thin wrappers over existing functions providing the clean three-function
// interface that bots use. Delegates entirely to existing mutations/queries.

import { v } from "convex/values";
import { query } from "./_generated/server";
import { decisionOption, sourceThread, urgencyLevel } from "./schema";
import { withAuthQ } from "./auth";

// requestDecision — re-exported from decisions.ts (already has bot/owner auth)
export { requestDecision } from "./decisions";

// requestCommand — re-exported from commands.ts (already has bot/owner/operator auth)
export { requestCommand } from "./commands";

// reportArtifact — re-exported from artifacts.ts (already has bot/owner auth)
export { reportArtifact } from "./artifacts";

// ── awaitDecision query (bot/owner) ─────────────────────────────
// Bot polls this to check decision status. Returns simplified outcome.
// v2: replace polling with Workflow signal wake.

export const awaitDecision = query({
  args: {
    projectId: v.string(),
    decisionId: v.string(),
  },
  handler: withAuthQ({ roles: ["bot", "owner"] }, async (ctx, args, auth) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("by_decisionId", (q) => q.eq("decisionId", args.decisionId))
      .unique();

    if (!decision) return null;
    if (decision.projectId !== auth.projectId) return null;

    return {
      status: decision.state.toLowerCase() as "pending" | "claimed" | "rendered" | "expired",
      selectedOption: decision.renderedOption ?? undefined,
      renderedBy: decision.renderedBy ?? undefined,
      note: undefined, // note lives on the event, not the decision doc
    };
  }),
});
