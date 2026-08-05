import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { DB_ERROR_COPY, DbError, type DbErrorKind } from "@/lib/db";

/**
 * Database failure as a rendered state rather than a thrown error.
 *
 * Each failure mode gets copy that says what to do next, which is the difference
 * between a useful error and a stack trace: "the instance may be paused" is
 * actionable, "ServiceUnavailable" is not. The raw database message is kept but
 * demoted — useful when debugging, noise when you only want to know why the page
 * is empty.
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
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.8"
          >
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

function toErrorState(context: string, error: unknown): ReactNode {
  if (error instanceof DbError) {
    return <DbErrorState kind={error.kind} detail={error.detail} context={context} />;
  }
  // Not a database problem, so do not mislabel it as one.
  return (
    <DbErrorState
      kind="query"
      context={context}
      detail={error instanceof Error ? (error.stack ?? error.message) : String(error)}
    />
  );
}

/**
 * Render a data-dependent region, or an explanation of why it could not load.
 *
 * Every such region on every page goes through this, so a page either shows its
 * data or says what went wrong — never a half-rendered shell or a framework error
 * overlay.
 */
export async function withDbFallback<T>(
  context: string,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  try {
    return render(await load());
  } catch (error) {
    return toErrorState(context, error);
  }
}

/**
 * Load the record a detail page is about.
 *
 * A page keyed on an id has to distinguish three outcomes: the record exists, it
 * does not, or the database could not answer. Collapsing the last two into a 404
 * would tell someone their advisory does not exist when the instance is merely
 * paused, so a database failure renders the error state and only a genuine miss
 * calls notFound().
 */
export async function loadOrNotFound<T>(
  context: string,
  load: () => Promise<T | null>,
): Promise<{ data: T } | { errorState: ReactNode }> {
  let record: T | null;
  try {
    record = await load();
  } catch (error) {
    return { errorState: toErrorState(context, error) };
  }
  if (record === null) notFound();
  return { data: record };
}
