"use client";

import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { Chapter } from "./Section";

const pillars = [
  {
    n: "01",
    tag: "Built on-chain",
    title: "Nothing to smuggle.",
    body: "The contract writes every EVM transaction and every intent from typed fields. A request has no field for a hash or a raw transaction, so a compromised agent has nothing to slip in.",
    icon: (
      <>
        <rect x="34" y="18" width="52" height="84" rx="4" />
        <path d="M46 40h28M46 54h28M46 68h18" />
        <path stroke="var(--color-string)" className="pillar-string" d="M8 96C30 96 30 60 46 82" />
      </>
    ),
  },
  {
    n: "02",
    tag: "Proven on-chain",
    title: "Settled means proven.",
    body: "A Base payment counts as done when NEAR's MPC network attests it's final and succeeded, not when a server says so. Anyone can submit that proof; nobody can fake it.",
    icon: (
      <>
        <circle cx="60" cy="60" r="34" />
        <path d="M44 61l11 11 22-24" />
        <path stroke="var(--color-string)" className="pillar-string" d="M8 30C26 30 22 60 26 60" />
      </>
    ),
  },
  {
    n: "03",
    tag: "Locked on-chain",
    title: "Nobody swaps the code.",
    body: "Accounts come from a locked factory and hold no keys. Tightening is instant; loosening waits out a timelock; code can only move to hashes the factory published.",
    icon: (
      <>
        <rect x="32" y="54" width="56" height="44" rx="4" />
        <path
          stroke="var(--color-string)"
          className="pillar-string"
          d="M44 54V40c0-9 7-16 16-16s16 7 16 16v14"
        />
        <circle cx="60" cy="76" r="5" />
      </>
    ),
  },
];

export function NothingToTrust() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.utils.toArray<HTMLElement>(".pillar").forEach((p) => {
        const tl = gsap.timeline({ scrollTrigger: { trigger: p, start: "top 80%" } });
        tl.from(p.querySelectorAll("svg path, svg rect, svg circle"), {
          drawSVG: "0%",
          duration: 1.2,
          stagger: 0.08,
          ease: "power2.inOut",
        }).from(
          p.querySelectorAll(".pillar-text > *"),
          { y: 30, autoAlpha: 0, stagger: 0.08, duration: 0.8, ease: "expo.out" },
          0.3,
        );
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} className="surface-ink grain relative px-5 py-24 md:px-10 md:py-36">
      <Chapter n="04" label="Nothing to trust" dark />
      <h2 className="display mt-8 max-w-5xl text-[clamp(2.5rem,6.4vw,6.8rem)]">
        No server <span className="text-paper/45">in the</span> middle.
      </h2>
      <div className="mt-16 grid border-y border-paper/15 md:grid-cols-3">
        {pillars.map((p) => (
          <article
            key={p.n}
            className="pillar border-b border-paper/15 py-10 last:border-b-0 md:border-b-0 md:border-r md:px-8 md:py-14 md:first:pl-0 md:last:border-r-0 md:last:pr-0"
          >
            <div className="flex items-start justify-between">
              <span className="display text-[3.2rem] text-paper/90">{p.n}</span>
              <span className="eyebrow text-dim-ink">{p.tag}</span>
            </div>
            <svg
              viewBox="0 0 120 120"
              className="my-8 h-28 w-28"
              fill="none"
              stroke="var(--color-paper)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {p.icon}
            </svg>
            <div className="pillar-text">
              <h3 className="text-[1.6rem] font-bold leading-tight tracking-[-0.02em]">
                {p.title}
              </h3>
              <p className="mt-4 leading-relaxed text-paper/70">{p.body}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
