import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect, useRef, useState } from "react";

const CLAIM_RENEW_INTERVAL = 3 * 60 * 1000; // 3 minutes (claim is 5 min)

type Props = {
  projectId: string;
  decisionId: string;
  onBack: () => void;
};

export function DecisionDetail({ projectId, decisionId, onBack }: Props) {
  const detail = useQuery(api.decisions.decisionDetail, { projectId, decisionId });
  const claim = useMutation(api.decisions.claimDecision);
  const render = useMutation(api.decisions.renderDecision);
  const renew = useMutation(api.decisions.renewDecisionClaim);

  const [note, setNote] = useState("");
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<string | null>(null);
  const claimedRef = useRef(false);
  const renewTimer = useRef<ReturnType<typeof setInterval>>();

  // Auto-claim on mount
  useEffect(() => {
    if (!detail || claimedRef.current) return;
    if (detail.state !== "PENDING" && detail.state !== "CLAIMED") return;

    claimedRef.current = true;
    claim({ projectId, decisionId }).catch(() => {
      // silently ignore claim failures (may already be claimed by us)
    });

    // Start heartbeat renewal
    renewTimer.current = setInterval(() => {
      renew({ projectId, decisionId }).catch(() => {
        // claim may have expired or been released
      });
    }, CLAIM_RENEW_INTERVAL);

    return () => {
      if (renewTimer.current) clearInterval(renewTimer.current);
    };
  }, [detail, projectId, decisionId, claim, renew]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (renewTimer.current) clearInterval(renewTimer.current);
    };
  }, []);

  if (detail === undefined) {
    return <div className="p-8 text-center text-slate-500">Loading...</div>;
  }

  if (detail === null) {
    return (
      <div className="p-8 text-center">
        <p className="text-slate-500 mb-4">Decision not found.</p>
        <button onClick={onBack} className="text-blue-500 hover:underline">
          Back to queue
        </button>
      </div>
    );
  }

  const isRendered = detail.state === "RENDERED";
  const isExpired = detail.state === "EXPIRED";
  const isResolved = isRendered || isExpired;

  async function handleRender(optionKey: string) {
    setRendering(true);
    try {
      const result = await render({
        projectId,
        decisionId,
        optionKey,
        note: note.trim() || undefined,
      });
      if (result.status === "rendered") {
        setRenderResult(`Decision rendered: ${optionKey}`);
        if (renewTimer.current) clearInterval(renewTimer.current);
      } else if (result.status === "rejected") {
        setRenderResult(`Rejected: ${result.reason}`);
      }
    } catch (e: unknown) {
      setRenderResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Back button */}
      <button
        onClick={onBack}
        className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-4 flex items-center gap-1"
      >
        &lsaquo; Back to queue
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <UrgencyBadge urgency={detail.urgency} />
          <StateBadge state={detail.state} />
        </div>
        <h1 className="text-2xl font-bold mt-2">{detail.title}</h1>
        {detail.contextSummary && (
          <p className="text-slate-600 dark:text-slate-400 mt-2">{detail.contextSummary}</p>
        )}
        <div className="text-xs text-slate-400 mt-2">
          Requested {new Date(detail.requestedAt).toLocaleString()}
          {detail.expiresAt && (
            <span> &middot; Expires {new Date(detail.expiresAt).toLocaleString()}</span>
          )}
        </div>
      </div>

      {/* Options */}
      {!isResolved && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Choose an option
          </h3>
          <div className="grid gap-2">
            {detail.options.map((opt) => (
              <button
                key={opt.key}
                disabled={rendering}
                onClick={() => handleRender(opt.key)}
                className="text-left border border-slate-200 dark:border-slate-700 rounded-lg p-3 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-50"
              >
                <div className="font-medium">{opt.label}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">{opt.consequence}</div>
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)..."
            className="mt-3 w-full border border-slate-200 dark:border-slate-700 rounded-lg p-2 text-sm bg-transparent resize-none"
            rows={2}
          />
        </div>
      )}

      {/* Render result / resolved state */}
      {renderResult && (
        <div className="mb-6 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm">
          {renderResult}
        </div>
      )}

      {isRendered && (
        <div className="mb-6 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
          <span className="text-sm font-medium">Resolved: </span>
          <span className="text-sm">{detail.renderedOption}</span>
          {detail.renderedBy && (
            <span className="text-xs text-slate-400 ml-2">by {detail.renderedBy}</span>
          )}
        </div>
      )}

      {isExpired && (
        <div className="mb-6 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm">
          This decision has expired.
          {detail.fallbackOption && <span> Fallback: {detail.fallbackOption}</span>}
        </div>
      )}

      {/* Artifacts */}
      {detail.context.artifacts.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Artifacts
          </h3>
          <div className="space-y-2">
            {detail.context.artifacts.map((art) =>
              art ? (
                <ArtifactCard key={art.artifactId} artifact={art} projectId={projectId} />
              ) : null,
            )}
          </div>
        </div>
      )}

      {/* Event chain */}
      {detail.context.eventChain.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Event chain
          </h3>
          <div className="text-sm space-y-1 font-mono">
            {detail.context.eventChain.map((evt) => (
              <div key={evt.eventId} className="flex gap-3 text-xs">
                <span className="text-slate-400 shrink-0">
                  {new Date(evt.ts).toLocaleTimeString()}
                </span>
                <span>{evt.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Command spec */}
      {detail.context.command && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Command
          </h3>
          <pre className="text-xs bg-slate-50 dark:bg-slate-800 p-3 rounded-lg overflow-x-auto">
            {JSON.stringify(detail.context.command, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  const styles: Record<string, string> = {
    now: "bg-red-500 text-white",
    today: "bg-amber-400 text-black",
    whenever: "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-200",
  };
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded ${styles[urgency] ?? ""}`}>
      {urgency.toUpperCase()}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    PENDING: "text-blue-500",
    CLAIMED: "text-amber-500",
    RENDERED: "text-green-500",
    EXPIRED: "text-red-500",
  };
  return (
    <span className={`text-xs font-medium ${styles[state] ?? "text-slate-400"}`}>
      {state}
    </span>
  );
}

function ArtifactCard({
  artifact,
  projectId,
}: {
  artifact: {
    artifactId: string;
    logicalName: string;
    type: string;
    byteSize: number;
  };
  projectId: string;
}) {
  const full = useQuery(api.artifacts.getArtifact, {
    projectId,
    artifactId: artifact.artifactId,
  });

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium">{artifact.logicalName}</div>
        <div className="text-xs text-slate-400">
          {artifact.type} &middot; {formatBytes(artifact.byteSize)}
        </div>
      </div>
      {full?.downloadUrl && (
        <a
          href={full.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-500 hover:underline shrink-0"
        >
          Download
        </a>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
