/**
 * M9 will replace this stub with the two-screen shell (TraceScreen + RulesScreen,
 * frontend-events.md §3/§4). Kept rendering so `npm run dev -w @growthagent/web`
 * works from day zero.
 */
export default function App() {
  return (
    <main className="mx-auto max-w-3xl p-10">
      <h1 className="text-2xl font-bold tracking-tight">
        GrowthAgent <span className="text-accent">mission control</span>
      </h1>
      <p className="mt-3 text-mute">
        Screens arrive in M9 — live transaction trace + merchant rules config.
      </p>
      <p className="mt-1 text-mute">
        AI proposes. The gatekeeper disposes.
      </p>
    </main>
  );
}
