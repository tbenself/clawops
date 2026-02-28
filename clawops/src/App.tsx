import {
  Authenticated,
  Unauthenticated,
  useConvexAuth,
  useQuery,
} from "convex/react";
import { api } from "../convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";
import { DecisionQueue } from "./pages/DecisionQueue";

export default function App() {
  return (
    <div className="min-h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      <Authenticated>
        <Dashboard />
      </Authenticated>
      <Unauthenticated>
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-bold text-center mb-8">ClawOps</h1>
            <SignInForm />
          </div>
        </div>
      </Unauthenticated>
    </div>
  );
}

function Dashboard() {
  const projects = useQuery(api.projectSetup.myProjects);
  const [projectId, setProjectId] = useState<string | null>(null);

  // Auto-select first project
  const activeProjectId = projectId ?? projects?.[0]?.projectId ?? null;

  return (
    <>
      <Header projectId={activeProjectId} projects={projects} onSelectProject={setProjectId} />
      <main>
        {projects === undefined ? (
          <div className="p-8 text-center text-slate-500">Loading...</div>
        ) : projects.length === 0 ? (
          <div className="p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No projects yet</h2>
            <p className="text-slate-500">Create a project to get started.</p>
          </div>
        ) : activeProjectId ? (
          <DecisionQueue projectId={activeProjectId} />
        ) : null}
      </main>
    </>
  );
}

type Project = { projectId: string; name: string; role: string };

function Header({
  projectId,
  projects,
  onSelectProject,
}: {
  projectId: string | null;
  projects: Project[] | undefined;
  onSelectProject: (id: string) => void;
}) {
  return (
    <header className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="font-bold text-lg">ClawOps</span>
        {projects && projects.length > 1 && (
          <select
            value={projectId ?? ""}
            onChange={(e) => onSelectProject(e.target.value)}
            className="text-sm bg-transparent border border-slate-200 dark:border-slate-700 rounded px-2 py-1"
          >
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {projectId && <PendingBadge projectId={projectId} />}
      </div>
      <SignOutButton />
    </header>
  );
}

function PendingBadge({ projectId }: { projectId: string }) {
  const decisions = useQuery(api.decisions.pendingDecisions, { projectId });
  const count = decisions?.length ?? 0;
  if (count === 0) return null;

  const hasUrgent = decisions?.some((d) => d.urgency === "now");

  return (
    <span
      className={`text-xs font-bold px-2 py-0.5 rounded-full ${
        hasUrgent
          ? "bg-red-500 text-white"
          : "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
      }`}
    >
      {count}
    </span>
  );
}

function SignOutButton() {
  const { isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  if (!isAuthenticated) return null;
  return (
    <button
      className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
      onClick={() => void signOut()}
    >
      Sign out
    </button>
  );
}

function SignInForm() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const formData = new FormData(e.target as HTMLFormElement);
        formData.set("flow", flow);
        void signIn("password", formData).catch((err) => {
          setError(err.message);
        });
      }}
    >
      <input
        className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-transparent"
        type="email"
        name="email"
        placeholder="Email"
        autoComplete="email"
      />
      <input
        className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-transparent"
        type="password"
        name="password"
        placeholder="Password"
        autoComplete="current-password"
      />
      <button
        className="bg-blue-600 text-white rounded-lg px-3 py-2 font-medium hover:bg-blue-700 transition-colors"
        type="submit"
      >
        {flow === "signIn" ? "Sign in" : "Sign up"}
      </button>
      <p className="text-sm text-center text-slate-500">
        {flow === "signIn" ? "Don't have an account? " : "Already have an account? "}
        <button
          type="button"
          className="text-blue-500 hover:underline"
          onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
        >
          {flow === "signIn" ? "Sign up" : "Sign in"}
        </button>
      </p>
      {error && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
    </form>
  );
}
