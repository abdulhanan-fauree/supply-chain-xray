import { DB_ERROR_COPY, DbError, type DbErrorKind } from "@/lib/db";

/**
 * The database-unreachable state, rendered as a real screen rather than a thrown
 * error. Each failure mode gets copy that tells you what to do next, which is
 * the difference between a useful error and a stack trace: "instance may be
 * paused" is actionable, "ServiceUnavailable" is not.
 *
 * The raw database message is kept, but demoted into a details element — useful
 * when debugging, noise when you just want to know why the page is empty.
 */
export function DbErrorState({
  kind,
  detail,
  context,
}: {
  kind: DbErrorKind;
  detail?: string;
  context?: string;
}) {
  const copy = DB_ERROR_COPY[kind];

  return (
    <div className="rounded-xl border border-line bg-panel p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-high-soft text-high"
        >
          <svg viewBox="0 0 20 20" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.8">
            <path d="M10 6.5v4.2M10 13.6h.01" strokeLinecap="round" />
            <circle cx="10" cy="10" r="7.2" />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{copy.title}</h2>
          <p className="mt-1 text-sm text-ink-muted">{copy.hint}</p>
          {context && <p className="mt-2 text-sm text-ink-faint">While loading: {context}</p>}
          {detail && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-ink-faint hover:text-ink-muted">
                What the database reported
              </summary>
              <pre className="mt-2 max-w-full overflow-x-auto rounded-md border border-line bg-bg-subtle p-3 font-mono text-xs text-ink-muted">
                {detail}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Every page renders through this. A page either gets its data or gets an
 * explanation — it never gets a half-rendered shell or a Next.js error overlay,
 * which is what would happen if the driver's rejection were allowed to bubble.
 */
export async function withDbFallback<T>(
  context: string,
  load: () => Promise<T>,
  render: (data: T) => React.ReactNode,
): Promise<React.ReactNode> {
  try {
    return render(await load());
  } catch (error) {
    if (error instanceof DbError) {
      return <DbErrorState kind={error.kind} detail={error.detail} context={context} />;
    }
    // Not a database problem: an genuine application bug. Show it rather than
    // silently mislabelling it as a connectivity issue.
    return (
      <DbErrorState
        kind="query"
        context={context}
        detail={error instanceof Error ? (error.stack ?? error.message) : String(error)}
      />
    );
  }
}
