"use client";

import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { blob } from "@/lib/site";
import { Chapter } from "./Section";

const CAP = 150;
const rows = [
  { amount: 20, chain: "NEAR", what: "Data feed", outcome: "Paid", color: "var(--color-paid)" },
  { amount: 30, chain: "Base", what: "GPU hours", outcome: "Paid", color: "var(--color-paid)" },
  {
    amount: 10,
    chain: "Intents",
    what: "Swap to wNEAR",
    outcome: "Paid",
    color: "var(--color-paid)",
  },
  {
    amount: 45,
    chain: "NEAR",
    what: "Annual upgrade",
    outcome: "Co-signed",
    color: "var(--color-wait)",
  },
  {
    amount: 50,
    chain: "Base",
    what: "More GPU hours",
    outcome: "Refused: $45 left",
    color: "var(--color-refused)",
    refused: true,
  },
];
const chains = [
  { name: "NEAR", x: 200, y: 58 },
  { name: "Base", x: 600, y: 82 },
  { name: "Intents", x: 1000, y: 56 },
];

export function OneBudget() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const counter = { v: 0 };
      const out = root.current?.querySelector<HTMLElement>(".budget-count");
      const render = () => {
        if (out) out.textContent = `$${counter.v.toFixed(0)}`;
      };
      if (reducedMotion()) {
        counter.v = 105;
        render();
        return;
      }
      const mm = gsap.matchMedia();
      mm.add({ desktop: "(min-width: 768px)", mobile: "(max-width: 767px)" }, (ctx) => {
        const desktop = ctx.conditions?.desktop;
        const tl = gsap.timeline({
          defaults: { ease: "power2.out" },
          scrollTrigger: desktop
            ? { trigger: ".budget-stage", start: "top top", end: "+=2200", pin: true, scrub: 1 }
            : { trigger: ".budget-stage", start: "top 70%", end: "bottom 60%", scrub: 1 },
        });
        tl.from(".budget-string", { drawSVG: "0%", duration: 1 });
        let total = 0;
        rows.forEach((r, i) => {
          tl.from(`.budget-row-${i}`, { autoAlpha: 0, x: -30, duration: 0.5 });
          if (r.refused) {
            tl.to(".budget-bar-over", { scaleX: (total + r.amount) / CAP, duration: 0.3 }, "<")
              .to(".budget-bar-over", {
                scaleX: total / CAP,
                duration: 0.5,
                ease: "elastic.out(1,0.3)",
              })
              .to(
                ".budget-string",
                {
                  stroke: "var(--color-refused)",
                  strokeWidth: 5,
                  duration: 0.15,
                  yoyo: true,
                  repeat: 3,
                },
                "<",
              );
          } else {
            total += r.amount;
            tl.to(".budget-bar", { scaleX: total / CAP, duration: 0.6 }, "<").to(
              counter,
              { v: total, duration: 0.6, onUpdate: render },
              "<",
            );
            tl.to(
              `.chain-${r.chain}`,
              { scale: 1.25, transformOrigin: "50% 50%", duration: 0.2, yoyo: true, repeat: 1 },
              "<",
            );
          }
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} className="surface-paper grain relative overflow-hidden">
      <div className="budget-stage flex min-h-[100svh] flex-col px-5 py-24 md:px-10 md:pb-10 md:pt-28">
        <Chapter n="03" label="One budget, every chain" />
        <div className="mt-8 grid gap-10 md:grid-cols-[1fr_minmax(0,30rem)] md:items-end">
          <h2 className="display text-[clamp(2.5rem,6.4vw,6.8rem)]">
            $150 a day.
            <br />
            <span className="serif normal-case">Wherever</span> it&rsquo;s spent.
          </h2>
          <p className="mono text-[0.92rem] leading-relaxed text-ink/75">
            The owner declares USDC on NEAR, on Base and inside NEAR Intents to be the same unit.
            One rolling window covers all three, with no price oracle. These are the demo&rsquo;s
            real numbers.
          </p>
        </div>

        <svg viewBox="0 0 1200 140" className="mt-12 w-full" fill="none" aria-hidden="true">
          <path
            className="budget-string"
            d="M20 70C300 40 500 100 600 70S900 40 1180 70"
            stroke="var(--color-string)"
            strokeWidth="3"
          />
          {chains.map((c) => (
            <g key={c.name} className={`chain-${c.name}`}>
              <circle
                cx={c.x}
                cy={c.y}
                r="22"
                fill="var(--color-paper)"
                stroke="var(--color-ink)"
                strokeWidth="2.5"
              />
              <text
                x={c.x}
                y={c.y + 52}
                textAnchor="middle"
                className="mono"
                fontSize="18"
                fill="var(--color-ink)"
              >
                {c.name.toUpperCase()}
              </text>
            </g>
          ))}
        </svg>

        <div className="mt-10 grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-start">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="budget-count display text-[clamp(3rem,7vw,7rem)]">$0</span>
              <span className="mono text-dim">of ${CAP} today</span>
            </div>
            <div className="relative mt-4 h-5 border-2 border-ink">
              <div className="budget-bar-over absolute inset-y-0 left-0 w-full origin-left scale-x-0 bg-refused/40" />
              <div className="budget-bar absolute inset-y-0 left-0 w-full origin-left scale-x-0 bg-ink" />
            </div>
          </div>
          <ol className="mono text-[0.88rem] md:text-[0.95rem]">
            {rows.map((r, i) => (
              <li
                key={r.what}
                className={`budget-row-${i} grid grid-cols-[4.5rem_4.5rem_1fr] items-center gap-3 border-b border-ink/15 py-3 md:grid-cols-[5.5rem_5.5rem_1fr_auto]`}
              >
                <span className={r.refused ? "text-refused line-through" : ""}>${r.amount}.00</span>
                <span className="text-dim">{r.chain}</span>
                <span className="truncate">{r.what}</span>
                <span className="col-span-3 md:col-span-1" style={{ color: r.color }}>
                  {r.outcome}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="mono mt-8 text-[0.8rem] text-dim">
          Base&rsquo;s own budget still had $70 left; the shared one didn&rsquo;t.{" "}
          <a
            className="underline decoration-string underline-offset-4"
            href={blob("contracts/pursestrings/tests/intents.rs")}
          >
            Sandbox test
          </a>{" "}
          ·{" "}
          <a
            className="underline decoration-string underline-offset-4"
            href={blob("apps/agent/src/demo.ts")}
          >
            make demo
          </a>
        </p>
      </div>
    </section>
  );
}
