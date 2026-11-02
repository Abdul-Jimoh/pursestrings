"use client";

import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { Chapter } from "./Section";

const outcomes = [
  {
    id: "paid",
    label: "Paid",
    color: "var(--color-paid)",
    ask: "Pay the GPU merchant 30 USDC on Base",
    body: "Inside every limit. The contract writes the ERC-20 transfer itself and Chain Signatures signs it. The agent never touches a key.",
    y: 110,
  },
  {
    id: "wait",
    label: "Waits for you",
    color: "var(--color-wait)",
    ask: "Pay the data vendor 45 USDC",
    body: "Over the $40 co-sign line. It waits for the owner, and its budget is held so nothing else can spend it meanwhile.",
    y: 260,
  },
  {
    id: "refused",
    label: "Refused",
    color: "var(--color-refused)",
    ask: "Send 500 USDC to 0xATTACKER",
    body: "Not on the allowlist, and over the cap. Nothing moves. The reason is written on-chain so the agent can learn from it.",
    y: 410,
  },
];

const MAIN = "M150 260C300 260 400 260 520 260";
const exit = (y: number) => `M740 260C890 260 900 ${y} 1050 ${y}`;

export function HowItHolds() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reducedMotion()) return;
      const mm = gsap.matchMedia();
      mm.add("(min-width: 768px)", () => {
        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: ".how-stage",
            start: "top top",
            end: "+=2600",
            pin: true,
            scrub: 1,
          },
        });
        tl.from(".how-main", { drawSVG: "0%", duration: 1 });
        outcomes.forEach((o, i) => {
          const packet = `.packet-${o.id}`;
          const prev = outcomes[i - 1];
          tl.set(packet, { autoAlpha: 1 });
          if (prev) tl.to(`.panel-${prev.id}`, { autoAlpha: 0, duration: 0.3 });
          tl.fromTo(
            `.panel-${o.id}`,
            { autoAlpha: 0, y: 30 },
            { autoAlpha: 1, y: 0, duration: 0.4 },
          )
            .to(
              packet,
              {
                motionPath: { path: ".how-main", align: ".how-main", alignOrigin: [0.5, 0.5] },
                duration: 1.2,
              },
              "<",
            )
            .to(".contract-box", { stroke: o.color, duration: 0.2, yoyo: true, repeat: 1 })
            .fromTo(`.exit-${o.id}`, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.6 }, "<")
            .to(
              packet,
              {
                motionPath: {
                  path: `.exit-${o.id}`,
                  align: `.exit-${o.id}`,
                  alignOrigin: [0.5, 0.5],
                },
                duration: 1,
              },
              "<",
            )
            .to(`.node-${o.id}`, { fill: o.color, duration: 0.2 })
            .to(packet, { autoAlpha: 0, duration: 0.2 })
            .to({}, { duration: 0.6 });
        });
      });
      mm.add("(max-width: 767px)", () => {
        gsap.utils.toArray<HTMLElement>(".how-card").forEach((card) => {
          gsap.from(card, {
            y: 60,
            autoAlpha: 0,
            duration: 0.9,
            ease: "expo.out",
            scrollTrigger: { trigger: card, start: "top 88%" },
          });
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id="how" className="surface-ink grain relative">
      <div className="how-stage relative flex min-h-[100svh] flex-col px-5 py-24 md:px-10 md:pb-10 md:pt-28">
        <Chapter n="02" label="How it holds" dark />
        <h2 className="display mt-8 text-[clamp(2.5rem,6.4vw,6.8rem)]">
          The agent asks.
          <br />
          <span className="text-string">The contract decides.</span>
        </h2>

        <div className="mt-12 hidden flex-1 grid-cols-[minmax(0,22rem)_1fr] items-center gap-10 md:grid">
          <div className="relative h-56">
            {outcomes.map((o) => (
              <div key={o.id} className={`panel-${o.id} invisible absolute inset-0`}>
                <p className="eyebrow" style={{ color: o.color }}>
                  {o.label}
                </p>
                <p className="mono mt-4 text-[0.95rem] text-paper/60">&ldquo;{o.ask}&rdquo;</p>
                <p className="mt-4 text-[1.15rem] leading-snug text-paper/90">{o.body}</p>
              </div>
            ))}
          </div>
          <svg viewBox="0 0 1300 520" className="w-full" fill="none" aria-hidden="true">
            <path className="how-main" d={MAIN} stroke="var(--color-string)" strokeWidth="3" />
            {outcomes.map((o) => (
              <path
                key={o.id}
                className={`exit-${o.id}`}
                d={exit(o.y)}
                stroke={o.color}
                strokeWidth="3"
                opacity="0.9"
              />
            ))}
            <g>
              <circle cx="110" cy="260" r="40" stroke="var(--color-paper)" strokeWidth="2" />
              <text
                x="110"
                y="266"
                textAnchor="middle"
                className="mono"
                fill="var(--color-paper)"
                fontSize="15"
              >
                AGENT
              </text>
              <text
                x="110"
                y="330"
                textAnchor="middle"
                className="mono"
                fill="var(--color-dim-ink)"
                fontSize="13"
              >
                can only ask
              </text>
            </g>
            <rect
              className="contract-box"
              x="520"
              y="185"
              width="220"
              height="150"
              stroke="var(--color-paper)"
              strokeWidth="2"
            />
            <text
              x="630"
              y="242"
              textAnchor="middle"
              className="mono"
              fill="var(--color-paper)"
              fontSize="15"
            >
              POLICY
            </text>
            <text
              x="630"
              y="266"
              textAnchor="middle"
              className="mono"
              fill="var(--color-paper)"
              fontSize="15"
            >
              CONTRACT
            </text>
            <text
              x="630"
              y="300"
              textAnchor="middle"
              className="mono"
              fill="var(--color-dim-ink)"
              fontSize="12"
            >
              caps · windows · allowlist
            </text>
            {outcomes.map((o) => (
              <g key={o.id}>
                <circle
                  className={`node-${o.id}`}
                  cx="1068"
                  cy={o.y}
                  r="16"
                  stroke={o.color}
                  strokeWidth="3"
                  fill="transparent"
                />
                <text x="1096" y={o.y + 5} className="mono" fill="var(--color-paper)" fontSize="15">
                  {o.label.toUpperCase()}
                </text>
              </g>
            ))}
            {outcomes.map((o) => (
              <g key={o.id} className={`packet-${o.id} invisible`}>
                <rect x="-44" y="-15" width="88" height="30" rx="15" fill="var(--color-paper)" />
                <text
                  x="0"
                  y="5"
                  textAnchor="middle"
                  className="mono"
                  fill="var(--color-ink)"
                  fontSize="13"
                >
                  {o.ask.match(/\d+ USDC/)?.[0]}
                </text>
              </g>
            ))}
          </svg>
        </div>

        <div className="mt-12 flex flex-col gap-5 md:hidden">
          {outcomes.map((o) => (
            <article
              key={o.id}
              className="how-card border-l-[3px] bg-ink-2 p-5"
              style={{ borderColor: o.color }}
            >
              <p className="eyebrow" style={{ color: o.color }}>
                {o.label}
              </p>
              <p className="mono mt-3 text-[0.9rem] text-paper/60">&ldquo;{o.ask}&rdquo;</p>
              <p className="mt-3 leading-snug text-paper/90">{o.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
