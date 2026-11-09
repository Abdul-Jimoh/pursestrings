"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";

/** Written by `pnpm --filter @pursestrings/shop marathon` (`apps/shop/scripts/marathon.ts`). */
interface Summary {
  shop: string;
  board: string;
  from: number | null;
  to: number | null;
  attempts: number;
  refused: number;
  events: number;
  kinds: {
    kind: string;
    attempts: number;
    refused: number;
    how: "event" | "failed" | "protocol";
    why: string | null;
    samples: string[];
  }[];
}

const howText = {
  event: "Refused and logged on-chain",
  failed: "Transaction failed",
  protocol: "Refused by NEAR itself",
};

/** The contract's own words, from a logged decision or a failed call. */
function reason(why: string | null): string {
  if (!why) return "";
  try {
    const r = JSON.parse(why).reason;
    return typeof r === "string" ? r : (Object.keys(r)[0] ?? "");
  } catch {
    return why.replace(/^Error: /, "").slice(0, 80);
  }
}

export function Marathon() {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    fetch("/marathon.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setS)
      .catch(() => {});
  }, []);
  if (!s) return null;

  const day = (t: number | null) =>
    t ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : "";

  return (
    <section className="mt-20 md:mt-28">
      <header>
        <h2 className="heading-section">
          The attack marathon
          <span className="ml-3 text-[1rem] font-semibold tracking-normal text-dim-ink tabular-nums">
            {s.attempts.toLocaleString()}
          </span>
        </h2>
        <p className="mt-3 max-w-2xl leading-relaxed text-paper/65">
          We attacked this shop and the community bounty board {s.attempts.toLocaleString()} times
          on testnet ({day(s.from)}–{day(s.to)}): as a fooled agent with a real key, and as an
          outsider. {s.refused.toLocaleString()} were refused, {s.events.toLocaleString()} of them
          as decisions the contract logged on-chain.
        </p>
      </header>

      <div className="mt-8 hidden lg:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-paper/20">
              <th className="label pb-3 pr-6 text-dim-ink">Attack</th>
              <th className="label pb-3 pr-6 text-right text-dim-ink">Tries</th>
              <th className="label pb-3 pr-6 text-right text-dim-ink">Refused</th>
              <th className="label pb-3 pr-6 text-dim-ink">How</th>
              <th className="label pb-3 text-dim-ink">Examples</th>
            </tr>
          </thead>
          <tbody>
            {s.kinds.map((k) => (
              <tr key={k.kind} className="border-b border-paper/10 align-top">
                <td className="py-4 pr-6 font-semibold">{k.kind}</td>
                <td className="py-4 pr-6 text-right tabular-nums">{k.attempts}</td>
                <td
                  className={`py-4 pr-6 text-right font-semibold tabular-nums ${k.refused === k.attempts ? "text-paid" : "text-string"}`}
                >
                  {k.refused}
                </td>
                <td className="py-4 pr-6 text-paper/70">
                  {howText[k.how]}
                  <span className="mono block text-[0.8rem] text-dim-ink">{reason(k.why)}</span>
                </td>
                <td className="py-4">
                  <Samples txs={k.samples} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-8 flex flex-col border-t border-paper/20 lg:hidden">
        {s.kinds.map((k) => (
          <li key={k.kind} className="border-b border-paper/10 py-4">
            <p className="font-semibold">{k.kind}</p>
            <p className="mt-1 text-paper/70">
              <span className={k.refused === k.attempts ? "text-paid" : "text-string"}>
                {k.refused} of {k.attempts} refused
              </span>{" "}
              · {howText[k.how]}
            </p>
            <div className="mt-2">
              <Samples txs={k.samples} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Samples({ txs }: { txs: string[] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {txs.map((t) => (
        <a
          key={t}
          href={`https://testnet.nearblocks.io/txns/${t}`}
          target="_blank"
          rel="noreferrer"
          className="mono inline-flex items-center gap-1 text-[0.82rem] text-dim-ink underline underline-offset-4 hover:text-paper"
        >
          {t.slice(0, 8)}…
          <ArrowUpRight className="size-3" />
        </a>
      ))}
    </span>
  );
}
