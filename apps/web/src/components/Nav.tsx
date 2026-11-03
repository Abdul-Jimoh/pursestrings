"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { REPO } from "@/lib/site";
import { Wordmark } from "./Logo";
import { lockScroll } from "./SmoothScroll";

const links = [
  { href: "/#how", label: "How it holds" },
  { href: "/#verify", label: "Verify" },
  { href: "/range", label: "The Range" },
  { href: "/app", label: "Dashboard" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [solid, setSolid] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      setSolid(y > 24);
      if (Math.abs(y - last) > 6) setHidden(y > last && y > 160);
      last = y;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggle = useCallback((next: boolean) => {
    lockScroll(next);
    setOpen(next);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the menu whenever the route changes
  useEffect(() => toggle(false), [pathname, toggle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && toggle(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle]);

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-50 text-paper transition-[transform,background-color,border-color] duration-500 ease-out ${
          hidden && !open ? "-translate-y-full" : "translate-y-0"
        } ${
          solid && !open
            ? "border-b border-paper/10 bg-ink/95 backdrop-blur-md"
            : "border-b border-transparent"
        }`}
      >
        <nav className="relative z-10 flex items-center justify-between gap-6 px-5 py-4 md:px-10 md:py-5">
          <Link href="/" aria-label="Pursestrings home" onClick={() => toggle(false)}>
            <Wordmark />
          </Link>
          <ul className="hidden items-center gap-10 lg:flex">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={pathname === l.href ? "page" : undefined}
                  className="eyebrow transition-opacity hover:opacity-60 aria-[current=page]:text-string"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => toggle(!open)}
            aria-expanded={open}
            aria-controls="menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="relative -mr-2 grid h-11 w-11 place-items-center lg:hidden"
          >
            <span
              className={`absolute h-[2px] w-6 bg-current transition-transform duration-300 ${open ? "rotate-45" : "-translate-y-[5px]"}`}
            />
            <span
              className={`absolute h-[2px] w-6 bg-current transition-transform duration-300 ${open ? "-rotate-45" : "translate-y-[5px]"}`}
            />
          </button>
        </nav>
      </header>

      <div
        id="menu"
        className={`fixed inset-0 z-40 flex flex-col justify-between bg-ink px-5 pb-10 pt-28 transition-[opacity,visibility] duration-300 md:px-10 lg:hidden ${
          open ? "visible opacity-100" : "invisible opacity-0"
        }`}
      >
        <ul className="flex flex-col">
          {links.map((l, i) => (
            <li key={l.href} className="overflow-hidden border-b border-paper/10">
              <Link
                href={l.href}
                onClick={() => toggle(false)}
                tabIndex={open ? 0 : -1}
                className={`flex items-center justify-between gap-4 py-5 text-[clamp(1.8rem,9vw,3.5rem)] font-extrabold uppercase leading-none tracking-[-0.035em] transition-transform duration-500 ease-out [font-variation-settings:'wdth'_112] ${
                  open ? "translate-y-0" : "translate-y-full"
                }`}
                style={{ transitionDelay: open ? `${80 + i * 50}ms` : "0ms" }}
              >
                {l.label}
                <ArrowUpRight className="size-7 shrink-0 text-string" strokeWidth={2.25} />
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-4">
          <span className="eyebrow text-dim-ink">NEAR Hackathon 2026</span>
          <a
            href={REPO}
            tabIndex={open ? 0 : -1}
            className="eyebrow inline-flex items-center gap-1.5 whitespace-nowrap hover:text-string"
          >
            GitHub <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </>
  );
}
