"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { Chapter } from "./Section";

const businesses = [
  {
    eyebrow: "The shop",
    title: "Check before you pay.",
    body: "An AI agent sells a plain-English verdict on any NEAR account or 0x address: a lookalike, on the community scam list, brand new, or fine. Haggle all you like. The contract won't quote below the owner's floor, holds your payment until the check is delivered, and lets you take it back if it never arrives. The agent pays its own model bill from its earnings, in NEAR or in USDC on Base.",
    links: [
      { href: "/shop", label: "Order a check" },
      { href: "/shop/ledger", label: "Read its ledger" },
    ],
  },
  {
    eyebrow: "The bounty board",
    title: "Grow the list. Earn the trust.",
    body: "A Sputnik DAO owns a purse that pays people who report scam addresses. An agent reviews each report against fixed rules. A newcomer's payout needs one council member; paid reports earn points, points unlock payouts nobody has to approve, and big payouts go to a DAO vote. Every paid report joins the scam list the shop checks.",
    links: [{ href: "/bounties", label: "See the bounties" }],
  },
];

export function WhatRuns() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(".biz", {
        autoAlpha: 0,
        y: 28,
        stagger: 0.12,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: ".bizzes", start: "top 80%" },
      });
    },
    { scope: root },
  );

  return (
    <section
      ref={root}
      id="what-runs"
      className="surface-paper grain relative overflow-hidden border-t border-ink/15 px-5 py-24 md:px-10 md:py-36"
    >
      <Chapter n="02" label="What runs on it" />
      <h2 className="display mt-8 max-w-5xl text-[clamp(2.5rem,6.4vw,6.8rem)]">
        Two businesses. <span className="text-string">Nobody holds the till.</span>
      </h2>
      <p className="mt-8 max-w-2xl text-[1.05rem] leading-relaxed text-ink/75">
        The policy isn&rsquo;t only a demo. An AI agent runs a shop on it, a community DAO runs a
        bounty board on it, and the money between them moves only by the contract&rsquo;s rules.
      </p>
      <div className="bizzes mt-14 grid gap-6 lg:grid-cols-2">
        {businesses.map((b) => (
          <article
            key={b.title}
            className="biz flex flex-col border border-ink/15 bg-paper p-7 md:p-10"
          >
            <p className="eyebrow text-string">{b.eyebrow}</p>
            <h3 className="heading-card mt-4 text-ink">{b.title}</h3>
            <p className="mt-5 flex-1 leading-relaxed text-ink/75">{b.body}</p>
            <div className="mt-8 flex flex-wrap gap-6">
              {b.links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="group inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 font-extrabold uppercase tracking-[-0.01em] text-ink"
                >
                  {l.label}
                  <ArrowUpRight
                    className="size-5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    strokeWidth={2.25}
                  />
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p className="mono mt-10 text-[0.95rem] text-ink/70">
        Every sale, split by the contract: 70% to the owner · 20% to the community DAO · 10% kept
        for refunds
      </p>
    </section>
  );
}
