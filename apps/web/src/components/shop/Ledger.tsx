"use client";

import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DAO_ACCOUNT, fetchPolicy, type Policy, SHOP_ACCOUNT } from "@/lib/policy";
import { type Cost, type LedgerOrder, levelColor, near, shop, target } from "@/lib/shop";
import { Stats } from "../Stats";

const when = (s: number) =>
  new Date(s * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const statusText: Record<LedgerOrder["status"], string> = {
  Quoted: "Quoted, not paid",
  Paid: "Paid, held",
  Delivered: "Delivered",
  Refunded: "Refunded",
};

export function Ledger() {
  const [orders, setOrders] = useState<LedgerOrder[] | null>(null);
  const [costs, setCosts] = useState<Cost[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      shop
        .ledger()
        .then((l) => {
          setOrders(l.orders);
          setCosts(l.costs);
          setError(null);
        })
        .catch(() => setError("The shop is offline right now."));
    load();
    fetchPolicy(SHOP_ACCOUNT)
      .then(setPolicy)
      .catch(() => {});
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const delivered = orders?.filter((o) => o.status === "Delivered") ?? [];
  const revenue = delivered.reduce((a, o) => a + BigInt(o.price), 0n);
  const daoBps = BigInt(policy?.split?.find((s) => s.account === DAO_ACCOUNT)?.bps ?? 0);
  const toDao = delivered.reduce((a, o) => a + (BigInt(o.price) * daoBps) / 10_000n, 0n);

  const stats = [
    { label: "Checks delivered", value: orders ? String(delivered.length) : "–" },
    { label: "Revenue", value: orders ? near(revenue) : "–" },
    { label: "To the community", value: orders && policy ? near(toDao) : "–" },
    {
      label: "Held right now",
      value: orders
        ? near(orders.filter((o) => o.status === "Paid").reduce((a, o) => a + BigInt(o.held), 0n))
        : "–",
      note: "until each check is delivered",
    },
  ];

  return (
    <div className="surface-ink grain relative px-5 pb-24 pt-32 md:px-10 md:pb-32 md:pt-44">
      <Link
        href="/shop"
        className="eyebrow inline-flex items-center gap-2 text-dim-ink hover:text-paper"
      >
        <ArrowLeft className="size-4" /> The shop
      </Link>
      <h1 className="display mt-8 text-[clamp(2.4rem,9vw,4rem)] md:text-[clamp(4rem,6.5vw,7rem)]">
        The <span className="text-string">ledger.</span>
      </h1>
      <p className="mt-6 max-w-2xl text-[1.1rem] leading-relaxed text-paper/70">
        Every order the agent has quoted, newest first, read from the shop&rsquo;s contract on NEAR
        testnet. Refused quotes and refunds are on-chain events on{" "}
        <a
          href={`https://testnet.nearblocks.io/address/${SHOP_ACCOUNT}`}
          target="_blank"
          rel="noreferrer"
          className="mono break-all underline decoration-paper/30 underline-offset-4 hover:decoration-string"
        >
          {SHOP_ACCOUNT}
        </a>
        .
      </p>

      <Stats stats={stats} className="mt-12" />

      <section className="mt-16 max-w-6xl">
        <h2 className="eyebrow text-dim-ink">Orders</h2>
        {error && <p className="mt-4 text-refused">{error}</p>}
        {orders?.length === 0 && <p className="mt-4 text-paper/60">No orders yet.</p>}
        {orders && orders.length > 0 && (
          <div className="mt-4 border-t border-paper/15">
            <div className="eyebrow hidden grid-cols-[4rem_minmax(0,1.6fr)_minmax(0,1.2fr)_7rem_8rem_8rem] gap-4 border-b border-paper/15 py-3 text-dim-ink lg:grid">
              <span>Order</span>
              <span>Checked</span>
              <span>Buyer</span>
              <span>Price</span>
              <span>Status</span>
              <span>Verdict</span>
            </div>
            {orders.map((o) => (
              <div
                key={o.id}
                className="grid gap-1 border-b border-paper/15 py-4 lg:grid-cols-[4rem_minmax(0,1.6fr)_minmax(0,1.2fr)_7rem_8rem_8rem] lg:gap-4"
              >
                <span className="font-bold">#{o.id}</span>
                <span className="mono min-w-0 break-all text-[0.92rem]">{target(o.item)}</span>
                <span className="mono min-w-0 break-all text-[0.92rem] text-paper/65">
                  {o.buyer ?? "anyone"}
                </span>
                <span>{near(o.price)}</span>
                <span className="text-paper/75">
                  {statusText[o.status]}
                  <span className="block text-[0.8rem] text-dim-ink">{when(o.quoted_at)}</span>
                </span>
                <span>
                  {o.verdict ? (
                    <span style={{ color: levelColor[o.verdict] }}>{o.verdict}</span>
                  ) : (
                    <span className="text-dim-ink">–</span>
                  )}
                  {o.deliverTx && (
                    <a
                      href={`https://testnet.nearblocks.io/txns/${o.deliverTx}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 flex items-center gap-1 text-[0.8rem] text-dim-ink underline underline-offset-4 hover:text-paper"
                    >
                      delivery <ArrowUpRight className="size-3" />
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-16 max-w-6xl">
        <h2 className="eyebrow text-dim-ink">The agent&rsquo;s own spending</h2>
        <p className="mt-4 max-w-2xl leading-relaxed text-paper/60">
          The agent pays its running costs through the same contract, under its own daily cap.
        </p>
        {costs.length === 0 ? (
          <p className="mt-4 text-paper/60">Nothing spent yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col border-t border-paper/15">
            {costs.map((c) => (
              <li
                key={c.id}
                className="grid gap-1 border-b border-paper/15 py-4 md:grid-cols-[4rem_minmax(0,1fr)_8rem_8rem] md:gap-4"
              >
                <span className="font-bold">#{c.id}</span>
                <span className="min-w-0 wrap-break-word text-paper/75">{c.spend.purpose}</span>
                <span>{near(c.spend.amount)}</span>
                <span className="text-paper/60">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
