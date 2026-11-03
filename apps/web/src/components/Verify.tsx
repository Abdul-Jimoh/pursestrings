"use client";

import { ArrowUpRight } from "lucide-react";
import { useRef } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";
import { blob } from "@/lib/site";
import { Chapter } from "./Section";

const T = "contracts/pursestrings/tests";
const proofs = [
  {
    claim: "The agent's key can't move funds or call owner methods",
    kind: "Sandbox test",
    href: blob(`${T}/invariants.rs`),
  },
  {
    claim: "The contract signs only transactions it built; no hash or raw tx field exists",
    kind: "Sandbox test",
    href: blob(`${T}/evm.rs`),
  },
  {
    claim: "Loosening waits out the timelock; tightening, freezing and revoking are instant",
    kind: "Sandbox test",
    href: blob(`${T}/invariants.rs`),
  },
  {
    claim: "Budgets are rolling windows; signed payments keep their budget until settled",
    kind: "Sandbox test",
    href: blob(`${T}/evm.rs`),
  },
  {
    claim: "Accounts hold no keys; code changes only to factory-published hashes",
    kind: "Sandbox test",
    href: blob(`${T}/factory.rs`),
  },
  {
    claim: "Swaps are checked by the intents.near code running on mainnet",
    kind: "Sandbox test",
    href: blob(`${T}/intents.rs`),
  },
  {
    claim: "One USDC budget across NEAR, Base and Intents",
    kind: "Sandbox test",
    href: blob(`${T}/intents.rs`),
  },
  {
    claim: "A real Base Sepolia payment, proven settled by the MPC network",
    kind: "Testnet tx",
    href: "https://sepolia.basescan.org/tx/0x0d5615a263515af48ff4aca3eef4ffbca84cc7519297c5f9cbc074efc1213e73",
  },
  {
    claim: "The whole story, from a fresh clone, in one command",
    kind: "make demo",
    href: blob("apps/agent/src/demo.ts"),
  },
  {
    claim: "Six attacks, the same result every run",
    kind: "make redteam",
    href: blob("scripts/redteam/expected.txt"),
  },
];

export function Verify() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(".proof", {
        autoAlpha: 0,
        y: 24,
        stagger: 0.05,
        duration: 0.7,
        ease: "expo.out",
        scrollTrigger: { trigger: ".proofs", start: "top 80%" },
      });
    },
    { scope: root },
  );

  return (
    <section
      ref={root}
      id="verify"
      className="surface-paper grain relative px-5 py-24 md:px-10 md:py-36"
    >
      <Chapter n="06" label="Verify it yourself" />
      <h2 className="display mt-8 text-[clamp(2.5rem,6.4vw,6.8rem)]">
        Don&rsquo;t take <span className="text-string">our</span> word.
      </h2>
      <ul className="proofs mt-14 border-t-2 border-ink">
        {proofs.map((p, i) => (
          <li key={p.claim} className="proof border-b border-ink/20">
            <a
              href={p.href}
              className="group grid grid-cols-[2.2rem_1fr] items-baseline gap-x-4 gap-y-2 py-5 md:grid-cols-[3rem_1fr_10rem_2rem] md:py-6"
            >
              <span className="mono text-dim">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[1.1rem] leading-snug md:text-[1.35rem]">{p.claim}</span>
              <span className="eyebrow col-start-2 text-string md:col-start-auto">{p.kind}</span>
              <ArrowUpRight className="hidden size-5 justify-self-end transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 md:block" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
