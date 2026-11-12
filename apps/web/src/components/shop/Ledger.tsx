"use client";

import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DAO_ACCOUNT, fetchPolicy, type Policy, SHOP_ACCOUNT } from "@/lib/policy";
import {
  type Cost,
  type LedgerOrder,
  levelColor,
  near,
  shop,
  spendAmount,
  target,
} from "@/lib/shop";
import { Stats } from "../Stats";
import { Marathon } from "./Marathon";

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

      <section className="mt-20 md:mt-28">
        <SectionHead
          title="Orders"
          count={orders?.length}
          intro="Newest first. A check is paid out only once its report is delivered on-chain."
        />
        {error && <p className="mt-6 text-refused">{error}</p>}
        {orders?.length === 0 && <p className="mt-6 text-paper/60">No orders yet.</p>}
        {orders && orders.length > 0 && (
          <>
            <table className="mt-8 hidden w-full border-collapse text-left lg:table">
              <thead>
                <tr className="border-b border-paper/20">
                  {["Order", "Address checked", "Buyer", "Price", "Status", "Verdict"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className={`${TH} ${h === "Price" ? "text-right" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-paper/10 align-top transition-colors hover:bg-paper/3"
                  >
                    <td className="py-5 pr-4">
                      <span className="text-[1.05rem] font-bold">#{o.id}</span>
                      <span className="mt-1 block whitespace-nowrap text-[0.85rem] text-dim-ink">
                        {when(o.quoted_at)}
                      </span>
                    </td>
                    <td className="mono py-5 pr-6 text-[0.9rem] break-all text-paper">
                      {target(o.item)}
                    </td>
                    <td className="mono py-5 pr-6 text-[0.85rem] break-all text-paper/60">
                      {o.buyer ?? "anyone"}
                    </td>
                    <td className="py-5 pr-6 text-right whitespace-nowrap tabular-nums">
                      {near(o.price)}
                    </td>
                    <td className="py-5 pr-6">
                      <StatusPill status={o.status} />
                    </td>
                    <td className="py-5">
                      <Verdict order={o} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="mt-8 flex flex-col gap-3 lg:hidden">
              {orders.map((o) => (
                <li key={o.id} className="border border-paper/15 bg-ink-2 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[1.05rem] font-bold">#{o.id}</span>
                    <StatusPill status={o.status} />
                  </div>
                  <p className="mono mt-4 text-[0.92rem] break-all">{target(o.item)}</p>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[0.9rem]">
                    <div className="col-span-2 min-w-0">
                      <dt className={TH}>Buyer</dt>
                      <dd className="mono mt-1 break-all text-paper/65">{o.buyer ?? "anyone"}</dd>
                    </div>
                    <div>
                      <dt className={TH}>Price</dt>
                      <dd className="mt-1 tabular-nums">{near(o.price)}</dd>
                    </div>
                    <div>
                      <dt className={TH}>Quoted</dt>
                      <dd className="mt-1 text-paper/65">{when(o.quoted_at)}</dd>
                    </div>
                    <div>
                      <dt className={TH}>Verdict</dt>
                      <dd className="mt-1">
                        <Verdict order={o} />
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <Marathon />

      <section className="mt-20 md:mt-28">
        <SectionHead
          title="The agent’s own spending"
          count={costs.length}
          intro="The agent pays its model costs through the same contract, under its own daily cap: in NEAR, or in USDC on Base through Chain Signatures."
        />
        {costs.length === 0 ? (
          <p className="mt-6 text-paper/60">Nothing spent yet.</p>
        ) : (
          <ul className="mt-8 flex flex-col border-t border-paper/20">
            {costs.map((c) => (
              <li
                key={c.id}
                className="grid gap-1 border-b border-paper/10 py-4 md:grid-cols-[4rem_minmax(0,1fr)_16rem_6rem] md:gap-4"
              >
                <span className="font-bold">#{c.id}</span>
                <span className="min-w-0 wrap-break-word text-paper/80">{c.spend.purpose}</span>
                <span className="tabular-nums md:text-right">{spendAmount(c)}</span>
                <span className="text-paper/60">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const TH = "label text-dim-ink pb-3 pr-6";

function SectionHead({ title, count, intro }: { title: string; count?: number; intro: string }) {
  return (
    <header>
      <h2 className="heading-section">
        {title}
        {count !== undefined && (
          <span className="ml-3 text-[1rem] font-semibold tracking-normal text-dim-ink tabular-nums">
            {count}
          </span>
        )}
      </h2>
      <p className="mt-3 max-w-2xl leading-relaxed text-paper/65">{intro}</p>
    </header>
  );
}

const statusTone: Record<LedgerOrder["status"], string> = {
  Quoted: "var(--color-dim-ink)",
  Paid: "var(--color-wait)",
  Delivered: "var(--color-paid)",
  Refunded: "var(--color-string)",
};

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap px-2.5 py-1 text-[0.85rem] font-semibold"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

function StatusPill({ status }: { status: LedgerOrder["status"] }) {
  return <Pill color={statusTone[status]}>{statusText[status]}</Pill>;
}

function Verdict({ order: o }: { order: LedgerOrder }) {
  return (
    <span className="flex flex-col items-start gap-1.5">
      {o.verdict ? (
        <Pill color={levelColor[o.verdict]}>{o.verdict}</Pill>
      ) : (
        <span className="text-[0.88rem] text-dim-ink">
          {o.status === "Delivered" ? "Report not kept here" : "Not checked yet"}
        </span>
      )}
      {o.deliverTx && (
        <a
          href={`https://testnet.nearblocks.io/txns/${o.deliverTx}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[0.85rem] text-dim-ink underline underline-offset-4 hover:text-paper"
        >
          Delivery <ArrowUpRight className="size-3" />
        </a>
      )}
    </span>
  );
}
