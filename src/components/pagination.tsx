import Link from "next/link";

/**
 * Server-rendered pagination via search params.
 *
 * Page state lives in the URL rather than in client state, which buys three
 * things worth more than the interactivity: a page of results is a link someone
 * can send to a colleague, the back button behaves, and no JavaScript is needed
 * to read the list. The trade-off is that reading searchParams makes the route
 * dynamic, so these pages lose static prerendering — acceptable because they
 * still cache for 60s, and a 600 KB single page was the worse problem.
 *
 * The param name is passed in so a page can paginate two independent lists
 * (the trust page has both), and every *other* param is preserved when building
 * links, so pagination composes with filters added later.
 */

export type Page<T> = {
  items: T[];
  pageNumber: number;
  pageCount: number;
  pageSize: number;
  total: number;
  /** 1-based index of the first item on this page, for "showing X–Y of Z". */
  firstIndex: number;
  lastIndex: number;
};

/**
 * Slice a result set into a page.
 *
 * Out-of-range and non-numeric input is clamped rather than rejected: `?page=0`,
 * `?page=999` and `?page=banana` all resolve to a real page instead of an error
 * or an empty list, because a hand-edited URL should not produce a broken screen.
 */
export function paginate<T>(items: T[], rawPage: string | undefined, pageSize: number): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const parsed = Number.parseInt(rawPage ?? "1", 10);
  const pageNumber = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), pageCount) : 1;
  const start = (pageNumber - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    pageNumber,
    pageCount,
    pageSize,
    total,
    firstIndex: total === 0 ? 0 : start + 1,
    lastIndex: Math.min(start + pageSize, total),
  };
}

/**
 * Page numbers to render, with `null` marking a gap.
 *
 * Always shows first and last so the ends of the list stay one click away, plus a
 * window around the current page. With 5 pages or fewer everything is shown and
 * no ellipsis appears.
 */
function pageWindow(current: number, count: number): Array<number | null> {
  if (count <= 5) return Array.from({ length: count }, (_, index) => index + 1);

  const pages = new Set<number>([1, count, current]);
  if (current - 1 > 1) pages.add(current - 1);
  if (current + 1 < count) pages.add(current + 1);

  const sorted = [...pages].sort((a, b) => a - b);
  const withGaps: Array<number | null> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) withGaps.push(null);
    withGaps.push(page);
  });
  return withGaps;
}

export function Pagination({
  page,
  basePath,
  param = "page",
  searchParams,
  label = "results",
}: {
  page: Page<unknown>;
  basePath: string;
  param?: string;
  /** Current params, so unrelated ones survive navigation. */
  searchParams?: Record<string, string | string[] | undefined>;
  label?: string;
}) {
  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (key === param || value === undefined) continue;
      params.set(key, Array.isArray(value) ? (value[0] ?? "") : value);
    }
    // Page 1 is the canonical URL — no param, so the link people share is clean.
    if (target > 1) params.set(param, String(target));
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const summary = (
    <p className="tnum text-xs text-ink-faint">
      Showing {page.firstIndex}–{page.lastIndex} of {page.total} {label}
    </p>
  );

  if (page.pageCount <= 1) {
    return <div className="border-t border-line px-5 py-3">{summary}</div>;
  }

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3"
    >
      {summary}

      <div className="flex items-center gap-1">
        <Step
          href={href(page.pageNumber - 1)}
          disabled={page.pageNumber === 1}
          label="Previous page"
        >
          ←
        </Step>

        {pageWindow(page.pageNumber, page.pageCount).map((target, index) =>
          target === null ? (
            <span key={`gap-${index}`} className="px-1 text-xs text-ink-faint" aria-hidden="true">
              …
            </span>
          ) : (
            <Link
              key={target}
              href={href(target)}
              aria-current={target === page.pageNumber ? "page" : undefined}
              className={`tnum min-w-7 rounded-md border px-2 py-1 text-center text-xs transition-colors ${
                target === page.pageNumber
                  ? "border-accent/40 bg-accent-soft font-medium text-accent"
                  : "border-line text-ink-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {target}
            </Link>
          ),
        )}

        <Step
          href={href(page.pageNumber + 1)}
          disabled={page.pageNumber === page.pageCount}
          label="Next page"
        >
          →
        </Step>
      </div>
    </nav>
  );
}

function Step({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    // Rendered as a span, not a disabled link: there is no such thing as a
    // disabled anchor, and a link to nowhere is worse than no link.
    return (
      <span
        aria-hidden="true"
        className="min-w-7 rounded-md border border-line px-2 py-1 text-center text-xs text-ink-faint opacity-40"
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="min-w-7 rounded-md border border-line px-2 py-1 text-center text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      {children}
    </Link>
  );
}
