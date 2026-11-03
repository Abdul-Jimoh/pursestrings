"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { REPO } from "@/lib/site";
import { FitText } from "./FitText";

export function Footer() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(".sig", {
        drawSVG: "0%",
        duration: 2.4,
        ease: "power2.inOut",
        scrollTrigger: { trigger: root.current, start: "top 75%" },
      });
      gsap.from(".sig-ring", {
        scale: 0,
        transformOrigin: "50% 50%",
        duration: 0.6,
        ease: "back.out(3)",
        delay: 2.2,
        scrollTrigger: { trigger: root.current, start: "top 75%" },
      });
    },
    { scope: root },
  );

  return (
    <footer
      ref={root}
      className="surface-ink grain relative overflow-hidden px-5 pb-8 pt-24 md:px-10 md:pt-36"
    >
      <p className="serif text-[clamp(1.8rem,4vw,3.4rem)] leading-tight text-paper/85">
        Give it a budget.
        <br />
        Keep the strings.
      </p>
      <svg viewBox="0 0 1400 220" className="mt-10 w-full" fill="none" aria-hidden="true">
        <path
          className="sig"
          d="M0 150C140 150 220 70 330 90S420 200 520 150 610 30 700 70 760 190 860 160 980 60 1080 100 1200 150 1290 140"
          stroke="var(--color-string)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <g className="sig-ring">
          <circle cx="1308" cy="140" r="16" stroke="var(--color-string)" strokeWidth="3" />
          <circle cx="1308" cy="140" r="4" fill="var(--color-string)" />
        </g>
      </svg>
      <p className="display mt-4 select-none text-center text-[calc((100vw-2.5rem)/9.6)] leading-[0.8] text-paper md:text-[calc((100vw-5rem)/9.6)]">
        <FitText>Pursestrings</FitText>
      </p>
      <div className="mt-10 flex flex-col gap-4 border-t border-paper/15 pt-6 md:flex-row md:items-center md:justify-between">
        <p className="eyebrow text-dim-ink">Built at NEAR Hackathon 2026 · Apache-2.0</p>
        <ul className="eyebrow flex flex-wrap gap-6">
          <li>
            <Link href="/range" className="hover:text-string">
              The Range
            </Link>
          </li>
          <li>
            <Link href="/app" className="hover:text-string">
              Dashboard
            </Link>
          </li>
          <li>
            <a href={REPO} className="inline-flex items-center gap-1.5 hover:text-string">
              GitHub <ArrowUpRight className="size-3.5" />
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
