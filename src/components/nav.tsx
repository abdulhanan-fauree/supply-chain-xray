"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation with an active indicator.
 *
 * The only client component in the application, and it exists for one reason:
 * knowing which section you are in requires the current pathname, which is a
 * client concern. Everything else renders on the server.
 *
 * A section stays marked while you are anywhere beneath it, so opening an
 * application from the overview does not leave the nav looking unanchored.
 */

const SECTIONS = [
  { href: "/", label: "Overview", match: (path: string) => path === "/" || path.startsWith("/apps") },
  { href: "/vulnerabilities", label: "Advisories" },
  { href: "/packages", label: "Packages" },
  { href: "/maintainers", label: "Trust" },
  { href: "/explore", label: "Explore" },
  { href: "/queries", label: "Queries" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex items-center gap-0.5 text-sm">
      {SECTIONS.map((section) => {
        const active =
          "match" in section && section.match
            ? section.match(pathname)
            : pathname === section.href || pathname.startsWith(`${section.href}/`);

        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={`relative rounded-md px-2.5 py-1.5 transition-colors ${
              active
                ? "font-medium text-ink"
                : "text-ink-muted hover:bg-bg-subtle hover:text-ink"
            }`}
          >
            {section.label}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-2.5 -bottom-[13px] h-px bg-accent"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
