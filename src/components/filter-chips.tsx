import Link from "next/link";

/**
 * Filters as links rather than form controls.
 *
 * Same reasoning as pagination: the filter lives in the URL, so a filtered view
 * is a shareable link, the back button behaves, and it works with no JavaScript.
 * Selecting a filter also resets pagination — staying on page 4 of a narrower
 * result set would land the reader on an empty screen.
 */

export type FilterOption = {
  /** Value written to the search param. Omit for the "all" case. */
  value?: string;
  label: string;
  count?: number;
  /** Tailwind classes applied when this option is active. */
  activeClass?: string;
};

export function FilterChips({
  basePath,
  param,
  options,
  current,
  searchParams,
  label,
  /** Params cleared when the filter changes, so pagination does not carry over. */
  resets = ["page"],
}: {
  basePath: string;
  param: string;
  options: FilterOption[];
  current?: string;
  searchParams?: Record<string, string | string[] | undefined>;
  label: string;
  resets?: string[];
}) {
  const href = (value?: string) => {
    const next = new URLSearchParams();
    for (const [key, raw] of Object.entries(searchParams ?? {})) {
      if (key === param || resets.includes(key) || raw === undefined) continue;
      next.set(key, Array.isArray(raw) ? (raw[0] ?? "") : raw);
    }
    if (value) next.set(param, value);
    const query = next.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-ink-faint">{label}</span>
      {options.map((option) => {
        const active = (option.value ?? "") === (current ?? "");
        return (
          <Link
            key={option.value ?? "all"}
            href={href(option.value)}
            aria-current={active ? "true" : undefined}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              active
                ? (option.activeClass ??
                  "border-accent/40 bg-accent-soft font-medium text-accent")
                : "border-line text-ink-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="tnum ml-1 opacity-60">{option.count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/** A GET search box. No client state; the URL is the state. */
export function SearchBox({
  basePath,
  param = "q",
  value,
  placeholder,
  searchParams,
  resets = ["page"],
}: {
  basePath: string;
  param?: string;
  value?: string;
  placeholder?: string;
  searchParams?: Record<string, string | string[] | undefined>;
  resets?: string[];
}) {
  const preserved = Object.entries(searchParams ?? {}).filter(
    ([key, raw]) => key !== param && !resets.includes(key) && raw !== undefined,
  );

  return (
    <form method="get" action={basePath} className="flex items-center gap-2">
      {/* Other active filters survive a search, as hidden fields. */}
      {preserved.map(([key, raw]) => (
        <input
          key={key}
          type="hidden"
          name={key}
          value={Array.isArray(raw) ? (raw[0] ?? "") : (raw as string)}
        />
      ))}
      <input
        type="search"
        name={param}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="field max-w-64 font-mono"
        aria-label={placeholder ?? "Search"}
      />
      <button
        type="submit"
        className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
      >
        Search
      </button>
      {value && (
        <Link
          href={basePath}
          className="text-xs text-ink-faint transition-colors hover:text-ink-muted"
        >
          clear
        </Link>
      )}
    </form>
  );
}
