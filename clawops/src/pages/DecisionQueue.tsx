import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { DecisionDetail } from "../components/DecisionDetail";
import { useState } from "react";

const URGENCY_BADGE: Record<string, { label: string; className: string }> = {
  now: { label: "NOW", className: "bg-red-500 text-white" },
  today: { label: "TODAY", className: "bg-amber-400 text-black" },
  whenever: { label: "WHENEVER", className: "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-200" },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function DecisionQueue({ projectId }: { projectId: string }) {
  const decisions = useQuery(api.decisions.pendingDecisions, { projectId });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (decisions === undefined) {
    return <div className="p-8 text-center text-slate-500">Loading decisions...</div>;
  }

  if (selectedId) {
    return (
      <DecisionDetail
        projectId={projectId}
        decisionId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  if (decisions.length === 0) {
    return (
      <div className="p-12 text-center">
        <div className="text-4xl mb-4">&#10003;</div>
        <h2 className="text-xl font-semibold mb-2">Queue clear</h2>
        <p className="text-slate-500">No pending decisions. You're all caught up.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        {decisions.length} pending decision{decisions.length !== 1 ? "s" : ""}
      </h2>
      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {decisions.map((d) => {
          const badge = URGENCY_BADGE[d.urgency];
          return (
            <li key={d.decisionId}>
              <button
                className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-start gap-3"
                onClick={() => setSelectedId(d.decisionId)}
              >
                <span
                  className={`shrink-0 mt-0.5 text-xs font-bold px-2 py-0.5 rounded ${badge.className}`}
                >
                  {badge.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{d.title}</div>
                  {d.contextSummary && (
                    <div className="text-sm text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {d.contextSummary}
                    </div>
                  )}
                  <div className="text-xs text-slate-400 dark:text-slate-500 mt-1 flex gap-3">
                    <span>{timeAgo(d.requestedAt)}</span>
                    <span>{d.options.length} option{d.options.length !== 1 ? "s" : ""}</span>
                    {d.state === "CLAIMED" && (
                      <span className="text-amber-500">claimed</span>
                    )}
                  </div>
                </div>
                <span className="text-slate-400 mt-1">&rsaquo;</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
