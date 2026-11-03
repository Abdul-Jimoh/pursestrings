"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { gsap, reducedMotion, revealLines, type SplitText, useGSAP } from "@/lib/gsap";

const TANGLED =
  "M610 -20C620 120 380 160 330 300C280 440 520 520 600 420C680 320 560 200 460 260C340 330 300 560 470 600C640 640 700 480 610 430C520 380 400 520 450 650C480 730 520 760 520 820";
const TAUT = "M610 -20C606 160 584 330 566 470C552 600 534 720 520 880";
const PULL = 60;

export function Hero() {
  const root = useRef<HTMLElement>(null);
  const [taut, setTaut] = useState(false);

  useGSAP(
    (_, contextSafe) => {
      if (reducedMotion()) return;
      let split: SplitText | undefined;
      const start = contextSafe?.(() => {
        const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
        split = revealLines(".hero-line", { stagger: 0.11, duration: 1.3 });
        tl.set(".hero-svg", { visibility: "visible" })
          .from(".hero-string", { drawSVG: "0%", duration: 2.2, ease: "power2.inOut" }, 0.2)
          .from(
            ".hero-ring",
            { scale: 0, transformOrigin: "50% 50%", duration: 0.8, ease: "back.out(3)" },
            1.9,
          )
          .fromTo(
            ".hero-fade",
            { y: 24, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 1, stagger: 0.08 },
            0.7,
          );
        gsap.to(".hero-content", {
          yPercent: -18,
          autoAlpha: 0.2,
          ease: "none",
          scrollTrigger: {
            trigger: root.current,
            start: "top top",
            end: "bottom top",
            scrub: true,
          },
        });
      });
      document.fonts.ready.then(() => start?.());
      return () => split?.revert();
    },
    { scope: root },
  );

  const { contextSafe } = useGSAP({ scope: root });

  const setPull = contextSafe((p: number, duration = 0) => {
    const q = Math.max(0, Math.min(1, p));
    gsap.to(".hero-string", {
      morphSVG: { shape: q > 0.5 ? TAUT : TANGLED },
      duration: duration || 0.9,
      ease: "elastic.out(1,0.5)",
      overwrite: true,
    });
    gsap.to(".hero-ring", {
      y: q > 0.5 ? PULL : 0,
      duration: duration || 0.9,
      ease: "elastic.out(1,0.5)",
      overwrite: true,
    });
    setTaut(q > 0.5);
  });

  const onPointerDown = contextSafe((e: React.PointerEvent<SVGGElement>) => {
    const startY = e.clientY;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = (ev.clientY - startY) / 140;
      gsap.to(".hero-ring", {
        y: Math.max(0, Math.min(PULL, p * PULL)),
        duration: 0.2,
        overwrite: true,
      });
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      setPull(taut ? 0 : (ev.clientY - startY) / 140 > 0.25 ? 1 : 0);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  });

  return (
    <section ref={root} className="surface-ink grain relative min-h-[100svh] overflow-hidden">
      <svg
        className="hero-svg reveal pointer-events-none absolute right-[-6%] top-0 hidden h-[100svh] w-auto md:block"
        viewBox="0 0 800 960"
        fill="none"
        aria-hidden="true"
      >
        <path
          className="hero-string"
          d={TANGLED}
          stroke="var(--color-string)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>; it has role, tabIndex and key handling instead */}
        <g
          className="hero-ring pointer-events-auto cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPull(taut ? 0 : 1)}
          role="button"
          tabIndex={0}
          aria-label={taut ? "Let the string go" : "Pull the string"}
        >
          <circle cx="520" cy="836" r="34" fill="transparent" />
          <circle cx="520" cy="836" r="16" stroke="var(--color-string)" strokeWidth="3" />
          <circle cx="520" cy="836" r="4" fill="var(--color-string)" />
        </g>
      </svg>

      <div className="hero-content relative z-10 flex min-h-[100svh] min-w-0 flex-col justify-end px-5 pb-10 pt-32 md:px-10 md:pb-14">
        <p className="eyebrow hero-fade reveal mb-8 max-w-[22rem] text-dim-ink md:max-w-none">
          On-chain spending policy for AI agents · NEAR · EVM · Intents
        </p>
        <h1 className="display min-w-0 text-[clamp(2.25rem,10.5vw,4.75rem)] md:text-[clamp(4rem,7.4vw,9.25rem)]">
          <span className="hero-line reveal block">Your agent</span>
          <span className="hero-line reveal block md:pl-[4vw]">holds the purse.</span>
          <span className="hero-line reveal block">You hold</span>
          <span className="hero-line reveal block text-string md:pl-[4vw]">the strings.</span>
        </h1>
        <div className="mt-10 grid gap-8 md:mt-14 md:grid-cols-[minmax(0,34rem)_1fr] md:items-end">
          <p className="hero-fade reveal max-w-[34rem] text-[1.05rem] leading-relaxed text-paper/80">
            One on-chain policy for every chain your agent touches: NEAR, every EVM chain through
            Chain Signatures, and NEAR Intents. The agent can only ask. The contract builds and
            checks every payment itself.
          </p>
          <div className="hero-fade reveal flex flex-wrap items-center gap-6 md:justify-end">
            <Link
              href="/range"
              className="group inline-flex items-center gap-3 border-b-2 border-paper pb-1 text-[1.35rem] font-extrabold uppercase tracking-[-0.02em]"
            >
              Try to break it{" "}
              <span className="transition-transform group-hover:translate-x-1 group-hover:-translate-y-1">
                ↗
              </span>
            </Link>
            <span className="eyebrow hidden text-dim-ink md:inline">
              {taut ? "Pulled tight: that's every request" : "Pull the string ↓"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
