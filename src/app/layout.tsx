import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Supply Chain X-Ray",
  description:
    "Trace which of your applications a published vulnerability actually reaches, through what chain of transitive dependencies, and which single direct dependency cuts it off.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/vulnerabilities", label: "Vulnerabilities" },
  { href: "/packages", label: "Packages" },
  { href: "/maintainers", label: "Trust" },
  { href: "/queries", label: "Queries" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-white"
              >
                X
              </span>
              Supply Chain X-Ray
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-ink-muted transition-colors hover:bg-bg-subtle hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>

        <footer className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-5 text-xs text-ink-faint">
            Dependency and advisory data from{" "}
            <a
              className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
              href="https://registry.npmjs.org"
            >
              registry.npmjs.org
            </a>{" "}
            and{" "}
            <a
              className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
              href="https://osv.dev"
            >
              OSV.dev
            </a>
            . Graph stored in CognoDB, queried with openCypher over Bolt.
          </div>
        </footer>
      </body>
    </html>
  );
}
