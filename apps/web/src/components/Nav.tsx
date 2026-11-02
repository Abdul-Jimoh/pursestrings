import Link from "next/link";
import { Wordmark } from "./Logo";

const links = [
  { href: "/#how", label: "How it holds" },
  { href: "/#verify", label: "Verify" },
  { href: "/range", label: "The Range" },
  { href: "/app", label: "Dashboard" },
];

export function Nav() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 mix-blend-difference">
      <nav className="pointer-events-auto mx-auto flex items-center justify-between px-5 py-5 text-paper md:px-10 md:py-7">
        <Link href="/" aria-label="Pursestrings home">
          <Wordmark />
        </Link>
        <ul className="hidden items-center gap-10 md:flex">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="eyebrow transition-opacity hover:opacity-60">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/range" className="eyebrow md:hidden">
          The Range →
        </Link>
      </nav>
    </header>
  );
}
