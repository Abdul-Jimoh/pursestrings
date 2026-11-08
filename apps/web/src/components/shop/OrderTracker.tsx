"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchPolicy, type Policy, SHOP_ACCOUNT, view } from "@/lib/policy";
import { levelColor, near, type Order, type Report, shop, target } from "@/lib/shop";
import { walletCall } from "@/lib/wallet";

const tx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
const link =
  "inline-flex items-center gap-1 text-[0.9rem] text-dim-ink underline underline-offset-4 hover:text-paper";

/** The agent's on-chain receipt is sha256 of the report as stored, without the receipt itself. */
async function receiptOf(r: Report): Promise<string> {
  const body = JSON.stringify({ ...r, receipt: undefined, deliverTx: undefined });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function OrderTracker({
  id,
  payTx,
  onDone,
  onNew,
}: {
  id: number;
  payTx: string | undefined;
  onDone: () => void;
  onNew: () => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [matches, setMatches] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    fetchPolicy(SHOP_ACCOUNT)
      .then(setPolicy)
      .catch(() => {});
    const poll = async () => {
      // The order comes from the chain itself; only the report text comes from the shop's server.
      const [o, r] = await Promise.all([
        view<Order | null>(SHOP_ACCOUNT, "order", { order_id: id }).catch(() => null),
        shop
          .order(id)
          .then((x) => x.report)
          .catch(() => null),
      ]);
      if (stop) return;
      setOrder(o);
      setReport(r);
      setNow(Date.now() / 1000);
      if (o?.status === "Delivered" && r) {
        setMatches((await receiptOf(r)) === o.receipt);
        onDone();
        return;
      }
      if (o?.status !== "Refunded") setTimeout(poll, 3_000);
    };
    poll();
    return () => {
      stop = true;
    };
  }, [id, onDone]);

  async function reclaim() {
    setError(null);
    try {
      await walletCall(SHOP_ACCOUNT, "reclaim", { order_id: id }, { tgas: 60n, deposit: "0" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!order) return <p className="text-paper/60">Reading order {id} from testnet…</p>;

  const paid = order.status !== "Quoted";
  const delivered = order.status === "Delivered";
  const late = order.status === "Paid" && order.deliver_by !== null && now >= order.deliver_by;

  return (
    <div>
      <p className="label text-dim-ink">
        Order {id} · check on <span className="mono normal-case">{target(order.item)}</span>
      </p>
      <ol className="mt-6 flex flex-col gap-5 border-l border-paper/15 pl-6">
        <Step
          done={paid}
          title={
            paid
              ? `${near(order.price)} paid and held by the contract`
              : "Waiting for your payment to land…"
          }
        >
          {payTx && (
            <a href={tx(payTx)} target="_blank" rel="noreferrer" className={link}>
              Your payment <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </Step>
        {paid && (
          <Step
            done={delivered}
            title={
              delivered
                ? "Checked and delivered"
                : order.status === "Refunded"
                  ? `Refunded ${near(order.refunded)}`
                  : "The agent is checking the address…"
            }
          >
            {report?.deliverTx && (
              <a href={tx(report.deliverTx)} target="_blank" rel="noreferrer" className={link}>
                The delivery <ArrowUpRight className="size-3.5" />
              </a>
            )}
          </Step>
        )}
        {delivered && policy?.split && (
          <Step done title="Split paid out">
            <span className="text-[0.95rem] text-paper/65">
              {policy.split
                .map(
                  (s) => `${near((BigInt(order.price) * BigInt(s.bps)) / 10_000n)} to ${s.account}`,
                )
                .join(", ")}
              ; the shop keeps {near(order.held)}.
            </span>
          </Step>
        )}
      </ol>

      {late && (
        <div className="mt-8 border border-wait/60 p-5">
          <p className="leading-relaxed">
            The agent missed its delivery window. Take your {near(order.held)} back: only you can,
            and it works even if the shop is frozen.
          </p>
          <button
            type="button"
            onClick={reclaim}
            className="mt-4 border-2 border-paper px-5 py-3 font-extrabold uppercase tracking-[-0.01em] hover:bg-paper hover:text-ink"
          >
            Take my money back
          </button>
        </div>
      )}
      {error && <p className="mt-5 text-refused">{error}</p>}

      {delivered && report && (
        <div className="mt-10 border border-paper/15 bg-ink p-5 md:p-8">
          <p className="label text-dim-ink">The report</p>
          <p
            className="display mt-4 text-[clamp(2rem,6vw,3.2rem)]"
            style={{ color: levelColor[report.verdict.level] }}
          >
            {report.verdict.level}.
          </p>
          <p className="mt-6 whitespace-pre-wrap leading-relaxed text-paper/85">{report.text}</p>
          <h3 className="label mt-8 text-dim-ink">Why</h3>
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 leading-relaxed text-paper/70">
            {report.verdict.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mt-8 text-[0.92rem] leading-relaxed text-paper/55">
            Fixed rules decided the verdict; the AI only wrote the explanation.{" "}
            {matches === true &&
              "This report hashes to the receipt the agent recorded on-chain, so it hasn't changed since delivery."}
            {matches === false && "This report doesn't match the receipt on-chain."}
          </p>
          <p className="mono mt-2 break-all text-[0.78rem] text-dim-ink">{order.receipt}</p>
        </div>
      )}

      {(delivered || order.status === "Refunded") && (
        <button
          type="button"
          onClick={onNew}
          className="mt-8 border-b border-paper/40 pb-1 text-paper/80 hover:border-paper hover:text-paper"
        >
          Check another address
        </button>
      )}
    </div>
  );
}

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="relative">
      <span
        className={`absolute top-1 -left-8.5 flex size-5 items-center justify-center rounded-full border ${done ? "border-paid bg-paid text-ink" : "border-paper/40 bg-ink-2"}`}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <p className={done ? "text-paper" : "text-paper/60"}>{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </li>
  );
}
