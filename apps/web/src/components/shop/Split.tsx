import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export function Split({
  split,
  kept,
  dao,
  timelock,
}: {
  split: { account: string; bps: number }[];
  kept: number;
  dao: string;
  timelock: string;
}) {
  const parts = [
    ...split.map((s) => ({
      key: s.account,
      bps: s.bps,
      who: s.account === dao ? "The community DAO" : "The shop's owner",
      what:
        s.account === dao ? (
          <>
            Its bounty purse pays people who grow the scam list.{" "}
            <Link href="/bounties" className="underline underline-offset-4 hover:text-paper">
              See the bounties
            </Link>
          </>
        ) : (
          "Paid straight to the owner's account."
        ),
      account: s.account,
      tone: s.account === dao ? "bg-paid" : "bg-string",
    })),
    {
      key: "kept",
      bps: kept,
      who: "Kept by the shop",
      what: "Covers refunds and the agent's running costs.",
      account: null,
      tone: "bg-paper/35",
    },
  ].filter((p) => p.bps > 0);

  return (
    <div>
      <div className="flex h-4 w-full gap-px overflow-hidden" role="img" aria-label="The split">
        {parts.map((p) => (
          <div key={p.key} className={p.tone} style={{ width: pct(p.bps) }} />
        ))}
      </div>
      <ul className="mt-8 flex flex-col border-t border-paper/15">
        {parts.map((p) => (
          <li
            key={p.key}
            className="grid gap-2 border-b border-paper/15 py-5 md:grid-cols-[6rem_minmax(0,1fr)] md:gap-6"
          >
            <span className="flex items-center gap-3 text-[1.6rem] font-bold tracking-[-0.02em]">
              <span className={`h-2.5 w-2.5 shrink-0 ${p.tone}`} />
              {pct(p.bps)}
            </span>
            <div className="min-w-0">
              <p className="font-bold">{p.who}</p>
              <p className="mt-1 leading-relaxed text-paper/65">{p.what}</p>
              {p.account && (
                <a
                  href={`https://testnet.nearblocks.io/address/${p.account}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono mt-2 inline-flex items-center gap-1 break-all text-[0.85rem] text-dim-ink underline underline-offset-4 hover:text-paper"
                >
                  {p.account}
                  <ArrowUpRight className="size-3.5 shrink-0" />
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 max-w-xl text-[0.95rem] leading-relaxed text-paper/55">
        Changing the split waits {timelock} in public. Shrinking the owner&rsquo;s share to send
        more to the community waits too: any change at all to where the money goes is treated as
        loosening.
      </p>
    </div>
  );
}
